/**
 * readout — renders the local file a developer (or their AI session) reads back with
 * "read me my buckets". PURE string building: no I/O, no database reads. The node
 * mirror (./mirror) writes this to `.crossdeck/buckets.md` on each flush, so the
 * readout works offline, for free, with no account.
 */
import type { BucketsReport, ResourceCounts } from "./sink";

/**
 * The one line that closes every readout. Plain and factual: what the OSS shows you
 * here, and what signing up adds — for free. No invented numbers, no urgency, no pitch.
 */
export const READOUT_FOOTER =
  "Buckets OSS shows the reads on this surface. Sign up to Crossdeck (free) to see " +
  "every surface in one view, drill any bucket down to the exact query, track a fix " +
  "before and after, and get paged when reads spike — cross-deck.com";

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "K";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(Math.round(n));
}

/** A bucket is untagged when its ROOT segment is a bare collection / catch-all. */
function isUntagged(label: string): boolean {
  const root = label.split(">")[0];
  return root.startsWith("col:") || root === "uncategorized" || root === "unknown";
}

/** Pretty path: strip the "col:" leaf prefix, join the hierarchy with " › ". */
function displayLabel(label: string): string {
  return label
    .split(">")
    .map((s) => (s.startsWith("col:") ? s.slice(4) : s))
    .join(" › ");
}

/** Render the day's coalesced report as a human/AI-readable markdown readout. */
export function renderReadout(report: BucketsReport): string {
  const entries = Object.entries(report.byLabel ?? {})
    .map(([label, counts]) => ({ label, reads: (counts as ResourceCounts).read ?? 0 }))
    .filter((e) => e.reads > 0)
    .sort((a, b) => b.reads - a.reads);

  const total = entries.reduce((s, e) => s + e.reads, 0);
  const out: string[] = [];
  out.push(`# Buckets — reads on this surface`);
  out.push(``);
  out.push(`**${fmt(total)} reads** · ${report.date} (UTC)`);
  out.push(``);

  if (entries.length === 0) {
    out.push(`No reads metered yet — install the collector and let your app serve some traffic.`);
  } else {
    out.push(`| bucket | named | reads |`);
    out.push(`| --- | :---: | ---: |`);
    for (const e of entries) {
      out.push(`| ${displayLabel(e.label)} | ${isUntagged(e.label) ? "—" : "✓"} | ${fmt(e.reads)} |`);
    }
  }

  out.push(``);
  out.push(`---`);
  out.push(READOUT_FOOTER);
  out.push(``);
  return out.join("\n");
}
