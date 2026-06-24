/**
 * THE one integration test — the whole safety net for @cross-deck/buckets.
 *
 * Exercises the real spine (meter + cost-context + the Firestore adapter) against
 * in-memory fakes — NEVER a live database (that's the CI cost monster). It proves,
 * in one place, every load-bearing property the README claims:
 *   - the spine works end-to-end (record → coalesce → flush → rollup),
 *   - C-1 env root-stamp: every label is rooted at the surface (`server>…`),
 *   - C-6 untagged is loud: an un-bucketed read surfaces as `unknown>col:x`,
 *   - nesting composes a path (`a>b>col:x`),
 *   - C-4 raw units only: counts are plain numbers, no currency anywhere,
 *   - C-5 no user dimension: the schema is {date, byLabel, byHour, byMinute} only,
 *   - the safety contract: a metering failure inside the trap can NEVER throw into
 *     the caller — the real read result is always returned untouched.
 *
 * That's the guard. The directive is the spec; this single test keeps CI cheap.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { configureMeter, recordReads, flush, ACTOR_SEP } from "../src/cost-meter";
import {
  bucket,
  setDefaultSurface,
  withActor,
  runWithCostTag,
  setRequestContext,
} from "../src/cost-context";
import {
  registerBucketsBridge,
  bridgeRequest,
  type RequestContext,
} from "../src/actor-bridge";
import {
  installFirestoreMeter,
  __resetFirestoreMeterForTests,
} from "../src/adapters/firestore";
import type { BucketsReport, Sink } from "../src/sink";

class CollectingSink implements Sink {
  reports: BucketsReport[] = [];
  async flush(r: BucketsReport): Promise<void> {
    this.reports.push(JSON.parse(JSON.stringify(r)));
  }
}

describe("buckets — the whole spine (one integration test)", () => {
  let sink: CollectingSink;

  beforeEach(async () => {
    sink = new CollectingSink();
    configureMeter({ sink });
    setDefaultSurface("server"); // the environment root (C-1)
    await flush();
    sink.reports.length = 0;
    __resetFirestoreMeterForTests();
  });

  it("env-rooted labels · raw counts · no user dimension · loud untagged", async () => {
    // A representative mix: one tagged bucket, one untagged read, one nested bucket.
    await bucket("x", async () => recordReads(3)); //                server>x
    recordReads(4, { collection: "posts" }); //                      server>unknown>col:posts  (untagged → loud)
    await bucket("a", () =>
      bucket("b", async () => recordReads(5, { collection: "events" })),
    ); //                                                            server>a>b>col:events

    await flush();
    const r = sink.reports[0]!;

    // Counts are correct and RAW (plain integers in the resource slot).
    expect(r.byLabel["server>x"]).toEqual({ read: 3 });
    expect(r.byLabel["server>unknown>col:posts"]).toEqual({ read: 4 }); // C-6: loud untagged
    expect(r.byLabel["server>a>b>col:events"]).toEqual({ read: 5 }); // nesting composes a path

    // C-1: EVERY label is rooted at the surface — no un-rooted leakage.
    for (const label of Object.keys(r.byLabel)) {
      expect(label.startsWith("server>")).toBe(true);
    }

    // C-5: the schema has NO user dimension — exactly these four keys, and every
    // value is a resource→count map (the only keys are raw resource units).
    expect(Object.keys(r).sort()).toEqual(["byHour", "byLabel", "byMinute", "date"]);
    for (const counts of Object.values(r.byLabel)) {
      for (const k of Object.keys(counts)) {
        expect(["read", "write", "delete"]).toContain(k); // raw units only — no "user", no "cost"
      }
    }

    // C-4: no currency token anywhere in the emitted rollup.
    expect(JSON.stringify(r)).not.toMatch(/\$|usd|dollar|"cost"|"price"|"rate"/i);
  });

  it("WHO × WHAT — reads attribute to the identified actor (the moat cross-match)", async () => {
    // Tory Michelle logs in → her Analytics reads attribute to HER, on that feature.
    // Only a tool that owns the SDK identity can do this; a query profiler never can.
    await withActor("tory@biotree.bio", () =>
      bucket("analytics", async () => recordReads(4000)),
    );
    // An unidentified visitor → clusters under `anonymous`, never dropped, never guessed.
    recordReads(50, { collection: "pages" });

    await flush();
    const r = sink.reports[0]!;

    // WHO — reads per identified actor, plus the honest anonymous cluster.
    expect(r.byActor?.["tory@biotree.bio"]).toEqual({ read: 4000 });
    expect(r.byActor?.["anonymous"]).toEqual({ read: 50 });
    // WHO × WHAT — "Tory Michelle · Analytics · 4,000" (env-rooted label; split on ACTOR_SEP).
    expect(r.byActorLabel?.[`tory@biotree.bio${ACTOR_SEP}server>analytics`]).toEqual({
      read: 4000,
    });
    // Still raw counts only — no currency anywhere, even with the WHO dimension on.
    expect(JSON.stringify(r)).not.toMatch(/\$|usd|dollar|"cost"|"price"|"rate"/i);
  });

  it("byActor is ABSENT until a REAL actor is seen — a pure-OSS install stays clean", async () => {
    recordReads(10, { collection: "events" }); // no setActor anywhere → all anonymous
    await flush();
    const r = sink.reports[0]!;
    expect(r.byActor).toBeUndefined(); // no all-anonymous noise
    expect(r.byActorLabel).toBeUndefined();
  });

  it("WHAT is feature-first: the operation outranks the page; collection is the leaf", async () => {
    // The boundary knows WHO + the autocaptured OPERATION + the page — set them as the
    // SDK bridge does, scoped to this request's context.
    await runWithCostTag({}, async () => {
      setRequestContext({
        actor: "tory@biotree.bio",
        feature: "analytics-refresh", // the cost driver (operation)
        route: "/analytics", // page — should NOT win over the operation
      });
      recordReads(4000, { collection: "events" });
    });
    await flush();
    const r = sink.reports[0]!;
    // WHAT = the OPERATION, with the collection as the drillable leaf, env-rooted —
    // NOT the page, NOT the bare collection.
    expect(r.byLabel["server>analytics-refresh>col:events"]).toEqual({ read: 4000 });
    // WHO × WHAT — "Tory · analytics-refresh".
    expect(
      r.byActorLabel?.[`tory@biotree.bio${ACTOR_SEP}server>analytics-refresh>col:events`],
    ).toEqual({ read: 4000 });
  });

  it("WHAT falls back: route when no operation, then the collection floor", async () => {
    await runWithCostTag({}, async () => {
      setRequestContext({ route: "/dashboard" }); // page known, operation not
      recordReads(7, { collection: "pages" });
    });
    await flush();
    expect(sink.reports[0]!.byLabel["server>/dashboard>col:pages"]).toEqual({ read: 7 });

    sink.reports.length = 0;
    recordReads(3, { collection: "events" }); // nothing known → the floor
    await flush();
    expect(sink.reports[0]!.byLabel["server>unknown>col:events"]).toEqual({ read: 3 });
  });

  it("the bridge is the decoupled seam — registerBucketsBridge ↔ bridgeRequest (no import either way)", () => {
    const calls: RequestContext[] = [];
    registerBucketsBridge((ctx) => calls.push(ctx));
    bridgeRequest({ actor: "u1", feature: "search" }); // what the SDK calls
    expect(calls).toEqual([{ actor: "u1", feature: "search" }]);
    bridgeRequest(undefined as unknown as RequestContext); // never throws on junk
  });

  it("safety contract — a metering failure inside the trap NEVER breaks the read", async () => {
    // A fake Query whose result throws the moment the meter tries to count it
    // (`.size`). The adapter must swallow that internally and return the real,
    // untouched result — a wrong count is a measurement error, never a broken read.
    const realResult = {
      sentinel: Symbol("real"),
      get size(): number {
        throw new Error("boom — counting must not escape");
      },
    };
    class FakeQuery {
      async get(): Promise<typeof realResult> {
        return realResult;
      }
    }
    installFirestoreMeter({ Query: FakeQuery as never });

    const out = await new FakeQuery().get();
    expect(out).toBe(realResult); // exact same object, despite the metering throw
  });
});
