import { describe, it, expect, beforeEach } from "vitest";
import { configureMeter, recordReads, flush } from "../src/cost-meter.js";
import { setDefaultSurface } from "../src/cost-context.js";
import { withBuckets } from "../src/with-buckets.js";
import type { BucketsReport, Sink } from "../src/sink.js";

/** A sink that keeps every report; can be told to throw once. */
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

const reads = (r?: BucketsReport): number =>
  Object.values(r?.byLabel ?? {}).reduce((s, o) => s + (o.read ?? 0), 0);

describe("withBuckets", () => {
  let sink: CollectingSink;

  beforeEach(async () => {
    sink = new CollectingSink();
    configureMeter({ sink, onError: () => void sink.errors++ });
    setDefaultSurface(undefined); // module-level state — reset so it can't leak
    await flush();
    sink.reports.length = 0;
  });

  it("flushes the invocation's counts before returning — no manual flush() needed", async () => {
    const handler = withBuckets(async (n: number) => {
      recordReads(n);
      return "ok";
    });

    const out = await handler(5);

    expect(out).toBe("ok");
    // The freeze guarantee: the window already shipped, with zero calls of our own.
    expect(sink.reports).toHaveLength(1);
    expect(reads(sink.reports[0])).toBe(5);
  });

  it("attributes the whole invocation to the named bucket", async () => {
    const handler = withBuckets("nightly-export", async () => {
      recordReads(7);
    });

    await handler();

    expect(sink.reports[0]!.byLabel["nightly-export"]).toEqual({ read: 7 });
  });

  it("flushes even when the handler throws, and re-throws the ORIGINAL error", async () => {
    const boom = new Error("handler blew up");
    const handler = withBuckets(async () => {
      recordReads(3);
      throw boom;
    });

    await expect(handler()).rejects.toBe(boom); // same error object, unchanged
    expect(reads(sink.reports[0])).toBe(3); // the reads happened → they still ship
  });

  it("forwards every argument and `this`, and returns the handler's value", async () => {
    const ctx = { id: 42 };
    const handler = withBuckets(async function (
      this: typeof ctx,
      a: number,
      b: string,
    ) {
      return `${this.id}:${a}:${b}`;
    });

    expect(await handler.call(ctx, 1, "x")).toBe("42:1:x");
  });

  it("a flush failure never escapes into the caller", async () => {
    sink.throwNext = true;
    const handler = withBuckets(async () => {
      recordReads(2);
      return "done";
    });

    // The sink is down, yet the handler's own result comes back clean.
    await expect(handler()).resolves.toBe("done");
    expect(sink.errors).toBe(1);
  });

  it("flushes once per INVOCATION, not once per wrap", async () => {
    const handler = withBuckets(async () => {
      recordReads(1);
    });

    await handler();
    await handler();

    expect(sink.reports).toHaveLength(2); // two invocations → two shipped windows
  });

  it("wrapping a non-function fails fast at setup", () => {
    // @ts-expect-error — name without a handler is a misuse the types reject too
    expect(() => withBuckets("name-only")).toThrow(TypeError);
    // @ts-expect-error
    expect(() => withBuckets(undefined)).toThrow(TypeError);
  });
});
