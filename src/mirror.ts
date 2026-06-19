/**
 * mirror — tees every coalesced report to a local file so "read me my buckets" works
 * offline, free, with no account. Writes a human/AI-readable readout
 * (`.crossdeck/buckets.md`) plus the raw report (`.crossdeck/buckets.json`).
 *
 * NODE ONLY — never imported by the browser build (it touches the filesystem).
 *
 * Two contracts it keeps:
 *  - NO MONSTER: it only ever WRITES local files (~one small write a minute). It never
 *    reads your database; the report is already in hand.
 *  - BEST-EFFORT: a write error is swallowed — the local mirror must never disturb a
 *    flush or reach your app.
 *
 * The meter hands each flush a DELTA (the window's counts, then clears). To show the
 * day's running total, the mirror accumulates deltas in memory, seeded once from any
 * existing file so a process restart doesn't shrink the readout.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sink, BucketsReport, ResourceCounts } from "./sink";
import { renderReadout } from "./readout";

export const DEFAULT_MIRROR_DIR = ".crossdeck";

function mergeInto(target: Record<string, ResourceCounts>, src?: Record<string, ResourceCounts>): void {
  if (!src) return;
  for (const [key, counts] of Object.entries(src)) {
    const bag = (target[key] ??= {});
    for (const [res, n] of Object.entries(counts)) {
      if (typeof n === "number") bag[res] = (bag[res] ?? 0) + n;
    }
  }
}

/**
 * Wraps an optional upstream sink. On each flush it writes the running day-total
 * locally, THEN (if an upstream sink was given — i.e. a key) reports onward.
 * With no upstream it is a pure local meter: the wedge, working with no account.
 */
export class MirrorSink implements Sink {
  private acc: BucketsReport | null = null;
  private announced = false;
  private seeded = false;

  constructor(
    private readonly upstream: Sink | null,
    private readonly dir: string = DEFAULT_MIRROR_DIR,
  ) {}

  private jsonPath(): string {
    return join(this.dir, "buckets.json");
  }

  /** Seed the running total once from an existing same-day file (survives restarts). */
  private seed(date: string): void {
    if (this.seeded) return;
    this.seeded = true;
    try {
      const prior = JSON.parse(readFileSync(this.jsonPath(), "utf8")) as BucketsReport;
      if (prior?.date === date && prior.byLabel) this.acc = prior;
    } catch {
      /* no prior file (or unreadable) — start fresh */
    }
  }

  async flush(report: BucketsReport): Promise<void> {
    // Local first — the part that always works, key or no key.
    try {
      this.seed(report.date);
      if (!this.acc || this.acc.date !== report.date) {
        this.acc = { date: report.date, byLabel: {}, byHour: {}, byMinute: {} };
      }
      mergeInto(this.acc.byLabel, report.byLabel);
      mergeInto((this.acc.byHour ??= {}), report.byHour);
      mergeInto((this.acc.byMinute ??= {}), report.byMinute);

      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, "buckets.md"), renderReadout(this.acc));
      writeFileSync(this.jsonPath(), JSON.stringify(this.acc, null, 2));

      if (!this.announced) {
        this.announced = true;
        // One quiet line, once, so a developer knows where to read it back.
        // eslint-disable-next-line no-console
        console.log(
          `Buckets: readout at ${join(this.dir, "buckets.md")} — open it, or ask your AI session to "read me my buckets".`,
        );
      }
    } catch {
      /* local mirror is best-effort */
    }

    if (this.upstream) await this.upstream.flush(report);
  }
}
