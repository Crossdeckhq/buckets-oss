import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the Firestore client SDK BEFORE importing the wrappers. Each fake just
// passes through; the wrappers add the counting around them.
vi.mock("firebase/firestore", () => ({
  getDoc: vi.fn(async (_ref: unknown) => ({ id: "x", exists: () => true })),
  getDocs: vi.fn(async (_q: unknown) => ({ size: 3, docs: [1, 2, 3] })),
  onSnapshot: vi.fn((_ref: unknown, next: any) => {
    // hand the listener a fake query snapshot with 4 "added" changes, then return unsub
    if (typeof next === "function") next({ docChanges: () => [1, 2, 3, 4] });
    else if (next?.next) next.next({ docChanges: () => [1, 2, 3, 4] });
    return () => {};
  }),
}));

const { getDoc, getDocs, onSnapshot } = await import("../src/web/firestore");
const ctx = await import("../src/web/context");
const { configureWebMeter, flushWeb } = await import("../src/web/meter");
import type { BucketsReport, Sink } from "../src/sink";

class CollectingSink implements Sink {
  reports: BucketsReport[] = [];
  async flush(r: BucketsReport) {
    this.reports.push(JSON.parse(JSON.stringify(r)));
  }
}

describe("web firestore wrappers", () => {
  let sink: CollectingSink;
  beforeEach(async () => {
    sink = new CollectingSink();
    configureWebMeter({ sink });
    await flushWeb();
    sink.reports.length = 0;
  });

  it("getDocs counts snapshot.size, labelled by collection", async () => {
    const fakeQuery = { path: "posts" };
    const snap = await getDocs(fakeQuery as any);
    expect(snap.size).toBe(3); // real result untouched
    await flushWeb();
    expect(sink.reports[0]!.byLabel["col:posts"]).toEqual({ read: 3 });
  });

  it("getDoc counts 1, labelled by the parent collection", async () => {
    await getDoc({ path: "posts/abc" } as any);
    await flushWeb();
    expect(sink.reports[0]!.byLabel["col:posts"]).toEqual({ read: 1 });
  });

  it("onSnapshot counts the docChanges delivered on each fire", async () => {
    onSnapshot({ path: "events" } as any, () => {});
    await flushWeb();
    expect(sink.reports[0]!.byLabel["col:events"]).toEqual({ read: 4 });
  });

  it("bucket() names the read instead of the collection cascade", async () => {
    await ctx.bucket("home-feed", () => getDocs({ path: "posts" } as any));
    await flushWeb();
    expect(sink.reports[0]!.byLabel["home-feed"]).toEqual({ read: 3 });
    expect(sink.reports[0]!.byLabel["col:posts"]).toBeUndefined();
  });

  it("the wrapped read returns the exact real result", async () => {
    const out = await getDoc({ path: "x/y" } as any);
    expect(out.id).toBe("x");
  });
});
