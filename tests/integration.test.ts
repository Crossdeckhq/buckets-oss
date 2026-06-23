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
import { configureMeter, recordReads, flush } from "../src/cost-meter";
import { bucket, setDefaultSurface } from "../src/cost-context";
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
