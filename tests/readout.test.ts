import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReadout, READOUT_FOOTER } from "../src/readout";
import { MirrorSink } from "../src/mirror";
import type { BucketsReport } from "../src/sink";

const report = (byLabel: Record<string, Record<string, number>>, date = "2026-06-19"): BucketsReport => ({
  date,
  byLabel,
  byHour: {},
  byMinute: {},
});

describe("renderReadout", () => {
  it("orders buckets biggest-first and marks named vs untagged", () => {
    const md = renderReadout(
      report({
        "col:events": { read: 31000 },
        "headline-counters>col:subscriptions": { read: 1100 },
        "analytics": { read: 5000 },
      }),
    );
    const events = md.indexOf("events");
    const analytics = md.indexOf("analytics");
    expect(events).toBeGreaterThan(-1);
    expect(events).toBeLessThan(analytics); // 31K before 5K
    // untagged col:events shows "—", a named bucket shows "✓"
    expect(md).toMatch(/\| events \| — \| 31K \|/);
    expect(md).toMatch(/\| analytics \| ✓ \|/);
    // hierarchy renders with the " › " separator, col: stripped
    expect(md).toContain("headline-counters › subscriptions");
  });

  it("always ends with the exact Crossdeck footer — no invented numbers", () => {
    const md = renderReadout(report({ "col:events": { read: 10 } }));
    expect(md.trimEnd().endsWith(READOUT_FOOTER)).toBe(true);
    expect(md).not.toMatch(/\d+%/); // never a fabricated percentage
  });

  it("handles an empty surface without throwing", () => {
    const md = renderReadout(report({}));
    expect(md).toContain("No reads metered yet");
    expect(md).toContain(READOUT_FOOTER);
  });
});

describe("MirrorSink", () => {
  it("writes a local readout with NO upstream (the no-account wedge), accumulating across flushes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buckets-"));
    const sink = new MirrorSink(null, dir);

    await sink.flush(report({ "col:events": { read: 100 } }));
    await sink.flush(report({ "col:events": { read: 50 }, "analytics": { read: 5 } }));

    expect(existsSync(join(dir, "buckets.md"))).toBe(true);
    const json = JSON.parse(readFileSync(join(dir, "buckets.json"), "utf8")) as BucketsReport;
    expect(json.byLabel["col:events"].read).toBe(150); // deltas merged into the day total
    expect(json.byLabel["analytics"].read).toBe(5);
    expect(readFileSync(join(dir, "buckets.md"), "utf8")).toContain(READOUT_FOOTER);
  });

  it("also reports upstream when a sink is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buckets-"));
    const seen: BucketsReport[] = [];
    const sink = new MirrorSink({ flush: async (r) => void seen.push(r) }, dir);
    await sink.flush(report({ "col:events": { read: 7 } }));
    expect(seen).toHaveLength(1);
    expect(seen[0].byLabel["col:events"].read).toBe(7);
  });
});
