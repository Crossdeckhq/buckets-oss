import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorSink } from "../src/mirror";
import { ACTOR_SEP } from "../src/constants";
import type { BucketsReport } from "../src/sink";

const tmp = (): string => mkdtempSync(join(tmpdir(), "buckets-mirror-"));

describe("MirrorSink", () => {
  it("carries byActor / byActorLabel through to the local readout (the cross-match)", async () => {
    const dir = tmp();
    const sink = new MirrorSink(null, dir);
    const report: BucketsReport = {
      date: "2026-06-24",
      byLabel: { "server>analytics-dashboard": { read: 31800 } },
      byActor: { "tory@biotree.bio": { read: 31800 } },
      byActorLabel: { [`tory@biotree.bio${ACTOR_SEP}server>analytics-dashboard`]: { read: 31800 } },
    };
    await sink.flush(report);

    // The JSON the `npx` CLI reads must retain the WHO dimension — the bug was that
    // the accumulator only merged byLabel/byHour/byMinute and dropped the actor maps.
    const json = JSON.parse(readFileSync(join(dir, "buckets.json"), "utf8"));
    expect(json.byActor["tory@biotree.bio"]).toEqual({ read: 31800 });
    expect(json.byActorLabel[`tory@biotree.bio${ACTOR_SEP}server>analytics-dashboard`]).toEqual({ read: 31800 });

    // And the rendered markdown must show the WHO sections, not just the bucket table.
    const md = readFileSync(join(dir, "buckets.md"), "utf8");
    expect(md).toContain("Who caused the reads");
    expect(md).toContain("tory@biotree.bio");
  });

  it("a pure-OSS report (no actor) writes a clean readout — no empty WHO sections", async () => {
    const dir = tmp();
    const sink = new MirrorSink(null, dir);
    await sink.flush({ date: "2026-06-24", byLabel: { "server>unknown>col:events": { read: 9 } } });

    const json = JSON.parse(readFileSync(join(dir, "buckets.json"), "utf8"));
    expect(json.byActor).toBeUndefined();
    const md = readFileSync(join(dir, "buckets.md"), "utf8");
    expect(md).not.toContain("Who caused the reads");
  });
});
