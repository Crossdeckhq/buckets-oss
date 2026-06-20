import { describe, it, expect, beforeEach } from "vitest";
import { configureMeter, flush } from "../src/cost-meter";
import { bucket } from "../src/cost-context";
import { installMongoMeter, MONGO_READ_UNIT } from "../src/mongo";
import type { BucketsReport } from "../src/sink";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Minimal stand-ins for the mongodb driver classes — toArray/findOne return canned
// results so we can prove the meter counts what they DELIVER, in the caller's bucket.
class FakeFindCursor {
  constructor(private docs: any[]) {}
  get namespace() {
    return { collection: "posts" };
  }
  async toArray() {
    return this.docs;
  }
}
class FakeAggCursor {
  constructor(private docs: any[]) {}
  get namespace() {
    return { collection: "events" };
  }
  async toArray() {
    return this.docs;
  }
}
class FakeCollection {
  collectionName = "users";
  constructor(private doc: any) {}
  async findOne() {
    return this.doc;
  }
}

function install() {
  installMongoMeter({
    FindCursor: FakeFindCursor as any,
    AggregationCursor: FakeAggCursor as any,
    Collection: FakeCollection as any,
  });
}

function sumUnder(report: BucketsReport | undefined, bucketPrefix: string, unit: string): number {
  const byLabel = report?.byLabel ?? {};
  return Object.keys(byLabel)
    .filter((k) => k === bucketPrefix || k.startsWith(`${bucketPrefix}>`))
    .reduce((s, k) => s + (byLabel[k][unit] ?? 0), 0);
}

describe("installMongoMeter", () => {
  let reports: BucketsReport[];
  // Patch the prototypes ONCE — re-patching would double-wrap toArray/findOne (the
  // `installed` guard prevents this in production; the test must not defeat it).
  install();
  beforeEach(() => {
    reports = [];
    configureMeter({ sink: { flush: async (r) => void reports.push(r) }, flushIntervalMs: 9_999_999 });
  });

  it("counts documents a find().toArray() returns, under the ambient bucket", async () => {
    await bucket("feed", () => new (FakeFindCursor as any)([1, 2, 3]).toArray());
    await flush();
    expect(sumUnder(reports[0], "feed", MONGO_READ_UNIT)).toBe(3);
  });

  it("counts documents an aggregate().toArray() returns", async () => {
    await bucket("rollup", () => new (FakeAggCursor as any)([{ _id: 1 }, { _id: 2 }]).toArray());
    await flush();
    expect(sumUnder(reports[0], "rollup", MONGO_READ_UNIT)).toBe(2);
  });

  it("findOne() is 1 for a hit, 0 for a miss", async () => {
    await bucket("hit", () => new (FakeCollection as any)({ _id: 1 }).findOne());
    await bucket("miss", () => new (FakeCollection as any)(null).findOne());
    await flush();
    expect(sumUnder(reports[0], "hit", MONGO_READ_UNIT)).toBe(1);
    expect(sumUnder(reports[0], "miss", MONGO_READ_UNIT)).toBe(0);
  });

  it("never lands in Firestore's 'read' unit — each resource is its own currency", async () => {
    await bucket("feed", () => new (FakeFindCursor as any)([1, 2, 3]).toArray());
    await flush();
    const byLabel = reports[0]?.byLabel ?? {};
    for (const counts of Object.values(byLabel)) {
      expect(counts.read).toBeUndefined();
    }
  });
});
