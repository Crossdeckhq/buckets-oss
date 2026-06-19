import { describe, it, expect, beforeEach } from "vitest";
import {
  configureMeter,
  record,
  recordReads,
  recordFirestore,
  flush,
} from "../src/cost-meter.js";
import { bucket } from "../src/cost-context.js";
import { installFirestoreMeter, __resetFirestoreMeterForTests } from "../src/adapters/firestore.js";
import type { BucketsReport, Sink } from "../src/sink.js";

/** A sink that keeps every report it's handed; can be told to throw once. */
class CollectingSink implements Sink {
  reports: BucketsReport[] = [];
  throwNext = false;
  errors = 0;
  async flush(report: BucketsReport): Promise<void> {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("sink is down");
    }
    this.reports.push(JSON.parse(JSON.stringify(report)));
  }
}

/** Drain the module-level buffer so each test starts clean. */
async function drain(sink: CollectingSink): Promise<void> {
  await flush();
  sink.reports.length = 0;
}

describe("cost-meter", () => {
  let sink: CollectingSink;

  beforeEach(async () => {
    sink = new CollectingSink();
    configureMeter({ sink, onError: () => void sink.errors++ });
    await drain(sink);
  });

  it("coalesces many records into one report per day, with correct increments", async () => {
    await bucket("home-feed", async () => {
      recordReads(3);
      recordReads(2);
    });
    await bucket("nightly-export", async () => {
      recordReads(10);
    });

    await flush();

    expect(sink.reports).toHaveLength(1);
    const r = sink.reports[0]!;
    expect(r.byLabel["home-feed"]).toEqual({ read: 5 });
    expect(r.byLabel["nightly-export"]).toEqual({ read: 10 });
    // The hourly view carries the same totals, keyed by UTC hour.
    const hourTotals = Object.values(r.byHour ?? {}).reduce((s, o) => s + (o.read ?? 0), 0);
    expect(hourTotals).toBe(15);
    // And the 5-minute view carries the same totals, keyed by slot ("HHMM").
    const minuteTotals = Object.values(r.byMinute ?? {}).reduce((s, o) => s + (o.read ?? 0), 0);
    expect(minuteTotals).toBe(15);
    expect(Object.keys(r.byMinute ?? {})[0]).toMatch(/^\d{4}$/); // slot key "HHMM"
  });

  it("cascades an untagged read to col:<collection>, and to uncategorized with nothing", async () => {
    recordReads(4, { collection: "posts" }); // no bucket → col:posts
    recordReads(1); // no bucket, no hint → uncategorized

    await flush();

    const r = sink.reports[0]!;
    expect(r.byLabel["col:posts"]).toEqual({ read: 4 });
    expect(r.byLabel["uncategorized"]).toEqual({ read: 1 });
  });

  it("never throws when the sink fails — the window is dropped and surfaced via onError", async () => {
    recordReads(7);
    sink.throwNext = true;

    await expect(flush()).resolves.toBeUndefined();
    expect(sink.errors).toBe(1);
    expect(sink.reports).toHaveLength(0);
  });

  it("a bucket name with separators (spaces, pipes) survives the round trip", async () => {
    await bucket("billing | monthly export", async () => {
      recordReads(2);
    });
    await flush();
    expect(sink.reports[0]!.byLabel["billing | monthly export"]).toEqual({ read: 2 });
  });

  it("counts writes and deletes alongside reads", async () => {
    await bucket("mutations", async () => {
      recordFirestore("write", 3);
      recordFirestore("delete", 1);
    });
    await flush();
    expect(sink.reports[0]!.byLabel["mutations"]).toEqual({ write: 3, delete: 1 });
  });

  it("records ANY resource unit, and each stays its OWN line — never merged", async () => {
    await bucket("search", async () => {
      record("read", 10000); // Firestore reads
      record("clickhouse.query_ms", 1250); // a totally different unit
      record("clickhouse.query_ms", 750); // accumulates WITHIN its own resource
    });
    await flush();
    // Two distinct resources under one bucket — separate slots, no cross-sum.
    expect(sink.reports[0]!.byLabel["search"]).toEqual({
      read: 10000,
      "clickhouse.query_ms": 2000,
    });
  });
});

describe("installFirestoreMeter (the trap)", () => {
  let sink: CollectingSink;

  beforeEach(async () => {
    sink = new CollectingSink();
    configureMeter({ sink });
    await drain(sink);
    __resetFirestoreMeterForTests();
  });

  it("counts a query's docs, is idempotent, and treats an empty result as 1", async () => {
    let realGetCalls = 0;
    // A minimal stand-in for firebase-admin's Query with a prototype `get`.
    class FakeQuery {
      size: number;
      constructor(size: number) {
        this.size = size;
      }
      async get(this: FakeQuery): Promise<{ size: number }> {
        realGetCalls++;
        return { size: this.size };
      }
    }

    // Installing twice must patch exactly once (no double count, no double call).
    installFirestoreMeter({ Query: FakeQuery as never });
    installFirestoreMeter({ Query: FakeQuery as never });

    await new FakeQuery(3).get(); // a 3-doc query → 3 reads
    await new FakeQuery(0).get(); // an empty query → still 1 read (billed minimum)

    await flush();

    expect(realGetCalls).toBe(2); // real method ran once per call, not twice
    const r = sink.reports[0]!;
    // No path/_queryOptions on the fake → cascades to "uncategorized".
    expect(r.byLabel["uncategorized"]).toEqual({ read: 4 }); // 3 + 1, not 8
  });

  it("returns the real, untouched result and cannot break the read", async () => {
    const marker = { size: 2, sentinel: Symbol("real") };
    class FakeDoc {
      async get(): Promise<typeof marker> {
        return marker;
      }
    }
    installFirestoreMeter({ DocumentReference: FakeDoc as never });
    const out = await new FakeDoc().get();
    expect(out).toBe(marker); // exact same object, untouched
  });

  it("AggregateQuery.get — counts ceil(count/1000), minimum 1", async () => {
    class FakeAgg {
      constructor(private c: number) {}
      async get(): Promise<{ data: () => { count: number } }> {
        const c = this.c;
        return { data: () => ({ count: c }) };
      }
    }
    installFirestoreMeter({ AggregateQuery: FakeAgg as never });
    await new FakeAgg(0).get(); // empty aggregate → billed minimum 1
    await new FakeAgg(2500).get(); // 2500 entries → ceil(2500/1000) = 3
    await flush();
    expect(sink.reports[0]!.byLabel["uncategorized"]).toEqual({ read: 4 }); // 1 + 3
  });

  it("Query.onSnapshot — counts the docChanges delivered on each fire", async () => {
    class FakeQ {
      onSnapshot(onNext: (s: unknown) => void): () => void {
        onNext({ docChanges: () => [1, 2, 3] }); // first fire: 3 docs
        onNext({ docChanges: () => [1] }); // an update: 1 changed
        return () => {};
      }
    }
    installFirestoreMeter({ Query: FakeQ as never });
    new FakeQ().onSnapshot(() => {});
    await flush();
    expect(sink.reports[0]!.byLabel["uncategorized"]).toEqual({ read: 4 }); // 3 + 1
  });

  it("DocumentReference.onSnapshot — counts 1 per fire", async () => {
    class FakeDocStream {
      onSnapshot(onNext: (s: unknown) => void): () => void {
        onNext({});
        onNext({});
        return () => {};
      }
    }
    installFirestoreMeter({ DocumentReference: FakeDocStream as never });
    new FakeDocStream().onSnapshot(() => {});
    await flush();
    expect(sink.reports[0]!.byLabel["uncategorized"]).toEqual({ read: 2 });
  });
});
