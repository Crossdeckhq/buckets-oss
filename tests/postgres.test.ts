import { describe, it, expect, beforeEach } from "vitest";
import { configureMeter, flush } from "../src/cost-meter";
import { bucket } from "../src/cost-context";
import { installPgMeter, PG_READ_UNIT } from "../src/postgres";
import type { BucketsReport } from "../src/sink";

/* eslint-disable @typescript-eslint/no-explicit-any */

// A minimal stand-in for node-postgres `Client`. `query()` echoes a canned Result so
// we can prove the meter counts the ROWS a SELECT delivers, in the caller's bucket —
// and supports both the promise and the legacy callback form. The `command` field is
// what node-postgres uses to distinguish a read from a write.
class FakeClient {
  constructor(private result: { command: string; rows: any[] }) {}
  query(this: any, _text: any, _values?: any, cb?: any): any {
    // Allow query(text, cb) as well as query(text, values, cb).
    const callback = typeof _values === "function" ? _values : cb;
    if (typeof callback === "function") {
      // Resolve on a later tick, like the real driver (socket round-trip).
      Promise.resolve().then(() => callback(null, this.result));
      return undefined;
    }
    return Promise.resolve(this.result);
  }
}

function install() {
  installPgMeter({ Client: FakeClient as any });
}

function sumUnder(report: BucketsReport | undefined, bucketPrefix: string, unit: string): number {
  const byLabel = report?.byLabel ?? {};
  return Object.keys(byLabel)
    .filter((k) => k === bucketPrefix || k.startsWith(`${bucketPrefix}>`))
    .reduce((s, k) => s + (byLabel[k][unit] ?? 0), 0);
}

function select(rows: any[]) {
  return { command: "SELECT", rows };
}

describe("installPgMeter", () => {
  let reports: BucketsReport[];
  // Patch the prototype ONCE — re-patching would double-wrap query (the `installed`
  // guard prevents this in production; the test must not defeat it).
  install();
  beforeEach(() => {
    reports = [];
    configureMeter({ sink: { flush: async (r) => void reports.push(r) }, flushIntervalMs: 9_999_999 });
  });

  it("counts the rows a SELECT returns, under the ambient bucket (promise form)", async () => {
    await bucket("billing-page", () => new (FakeClient as any)(select([1, 2, 3, 4])).query("SELECT 1"));
    await flush();
    expect(sumUnder(reports[0], "billing-page", PG_READ_UNIT)).toBe(4);
  });

  it("attributes through the callback form too", async () => {
    await bucket(
      "feed",
      () =>
        new Promise<void>((resolve) => {
          new (FakeClient as any)(select([{ id: 1 }, { id: 2 }])).query("SELECT *", () => resolve());
        }),
    );
    await flush();
    expect(sumUnder(reports[0], "feed", PG_READ_UNIT)).toBe(2);
  });

  it("does NOT count writes — an INSERT ... RETURNING is not a read", async () => {
    await bucket("signup", () =>
      new (FakeClient as any)({ command: "INSERT", rows: [{ id: 1 }] }).query("INSERT ... RETURNING id"),
    );
    await flush();
    expect(sumUnder(reports[0], "signup", PG_READ_UNIT)).toBe(0);
  });

  it("an empty result set counts zero", async () => {
    await bucket("search", () => new (FakeClient as any)(select([])).query("SELECT ... WHERE false"));
    await flush();
    expect(sumUnder(reports[0], "search", PG_READ_UNIT)).toBe(0);
  });

  it("never lands in Firestore's 'read' unit — each resource is its own currency", async () => {
    await bucket("billing-page", () => new (FakeClient as any)(select([1, 2, 3])).query("SELECT 1"));
    await flush();
    const byLabel = reports[0]?.byLabel ?? {};
    for (const counts of Object.values(byLabel)) {
      expect(counts.read).toBeUndefined();
    }
  });
});
