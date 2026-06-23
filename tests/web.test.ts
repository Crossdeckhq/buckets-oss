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
  getDocFromServer: vi.fn(async (_ref: unknown) => ({ id: "x" })),
  getDocsFromServer: vi.fn(async (_q: unknown) => ({ size: 5, docs: [1, 2, 3, 4, 5] })),
  getDocFromCache: vi.fn(async (_ref: unknown) => ({ id: "cached" })),
  getDocsFromCache: vi.fn(async (_q: unknown) => ({ size: 9, docs: [] })),
  getCountFromServer: vi.fn(async (_q: unknown) => ({ data: () => ({ count: 2500 }) })),
  getAggregateFromServer: vi.fn(async (_q: unknown) => ({ data: () => ({ count: 0 }) })),
}));

const { getDoc, getDocs, onSnapshot, getDocsFromServer, getDocsFromCache, getCountFromServer } =
  await import("../src/web/firestore");
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
    expect(sink.reports[0]!.byLabel["unknown>col:posts"]).toEqual({ read: 3 });
  });

  it("getDoc counts 1, labelled by the parent collection", async () => {
    await getDoc({ path: "posts/abc" } as any);
    await flushWeb();
    expect(sink.reports[0]!.byLabel["unknown>col:posts"]).toEqual({ read: 1 });
  });

  it("onSnapshot counts the docChanges delivered on each fire", async () => {
    onSnapshot({ path: "events" } as any, () => {});
    await flushWeb();
    expect(sink.reports[0]!.byLabel["unknown>col:events"]).toEqual({ read: 4 });
  });

  it("bucket() names the read instead of the collection cascade", async () => {
    await ctx.bucket("home-feed", () => getDocs({ path: "posts" } as any));
    await flushWeb();
    expect(sink.reports[0]!.byLabel["home-feed"]).toEqual({ read: 3 });
    expect(sink.reports[0]!.byLabel["unknown>col:posts"]).toBeUndefined();
  });

  it("the wrapped read returns the exact real result", async () => {
    const out = await getDoc({ path: "x/y" } as any);
    expect(out.id).toBe("x");
  });

  it("getDocsFromServer counts snapshot.size (a billed read)", async () => {
    await getDocsFromServer({ path: "posts" } as any);
    await flushWeb();
    expect(sink.reports[0]!.byLabel["unknown>col:posts"]).toEqual({ read: 5 });
  });

  it("getDocsFromCache counts NOTHING — cache hits aren't billed", async () => {
    const out = await getDocsFromCache({ path: "posts" } as any);
    expect(out.size).toBe(9); // real result returned
    await flushWeb();
    expect(sink.reports.length).toBe(0); // no report — zero reads counted
  });

  it("stamps the configured surface as the ROOT of every label — named and collection-cascade", async () => {
    configureWebMeter({ sink, surface: "web" });
    await ctx.bucket("pulse-map", () => getDocs({ path: "visitors" } as any));
    await getDocs({ path: "posts" } as any); // untagged → web>col:posts
    await flushWeb();
    expect(sink.reports[0]!.byLabel["web>pulse-map"]).toEqual({ read: 3 });
    expect(sink.reports[0]!.byLabel["web>unknown>col:posts"]).toEqual({ read: 3 });
    configureWebMeter({ sink }); // reset surface so later tests stay unprefixed
  });

  it("getCountFromServer estimates ceil(count/1000), min 1", async () => {
    await getCountFromServer({ path: "events" } as any); // mock count = 2500 → 3
    await flushWeb();
    expect(sink.reports[0]!.byLabel["unknown>col:events"]).toEqual({ read: 3 });
  });
});
