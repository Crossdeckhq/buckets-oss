/**
 * readout — renders the local readout a developer reads back. PURE string building:
 * no I/O, no database reads. The node mirror (./mirror) writes this to
 * `.crossdeck/buckets.md` on each flush, and `npx @cross-deck/buckets` prints it to
 * the terminal — so the readout works offline, for free, with no account.
 */
import type { BucketsReport, ResourceCounts } from "./sink";
import { ACTOR_SEP } from "./constants";

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

/** A bucket is untagged when the meter couldn't name it — i.e. it carries an
 *  `unknown` or `uncategorized` segment (the meter's catch-all markers). Checking
 *  for the segment (not the first one) is surface-root-safe: `server>unknown>col:x`
 *  reads as untagged even though its root segment is the `server` surface. */
function isUntagged(label: string): boolean {
  const segs = label.split(">");
  // Untagged if the meter couldn't name it: an explicit `unknown`/`uncategorized`
  // marker (incl. surface-rooted `server>unknown>col:x`), OR a bare collection with
  // no bucket name at all (`col:events`). A named bucket always has a real segment.
  return (
    segs.some((s) => s === "unknown" || s === "uncategorized") ||
    segs.every((s) => s.startsWith("col:"))
  );
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

  // WHO — the identity cross-match. Present ONLY when an actor was set (a customer's
  // own `setActor`, or the Crossdeck SDK). Two distinct axes, never merged: who caused
  // the reads, and who × which function. A machine read has no person but still its
  // tenant, so it shows as an actor here too (`machine`), keeping background work
  // attributable to a customer while honestly carrying no human.
  const actors = Object.entries(report.byActor ?? {})
    .map(([actor, c]) => ({ actor, reads: (c as ResourceCounts).read ?? 0 }))
    .filter((e) => e.reads > 0)
    .sort((a, b) => b.reads - a.reads);
  if (actors.length > 0) {
    out.push(``);
    out.push(`## Who caused the reads`);
    out.push(``);
    out.push(`| user | reads |`);
    out.push(`| --- | ---: |`);
    for (const e of actors) out.push(`| ${e.actor} | ${fmt(e.reads)} |`);
  }

  const cross = Object.entries(report.byActorLabel ?? {})
    .map(([key, c]) => {
      const i = key.indexOf(ACTOR_SEP);
      return {
        actor: i >= 0 ? key.slice(0, i) : key,
        label: i >= 0 ? key.slice(i + ACTOR_SEP.length) : "",
        reads: (c as ResourceCounts).read ?? 0,
      };
    })
    .filter((e) => e.reads > 0)
    .sort((a, b) => b.reads - a.reads);
  if (cross.length > 0) {
    out.push(``);
    out.push(`## Who × what — which user's which function`);
    out.push(``);
    out.push(`| user | function | reads |`);
    out.push(`| --- | --- | ---: |`);
    for (const e of cross) {
      out.push(`| ${e.actor} | ${displayLabel(e.label)} | ${fmt(e.reads)} |`);
    }
  }

  out.push(``);
  out.push(`---`);
  out.push(READOUT_FOOTER);
  out.push(``);
  return out.join("\n");
}
