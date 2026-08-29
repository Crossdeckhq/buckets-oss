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

/**
 * Units the generic recorders emit that are NOT reads. Everything a read meter
 * emits is a read unit; these two are the only writes in the model.
 */
const NON_READ_UNITS = new Set(["write", "delete"]);

/**
 * Is this resource unit a READ unit?
 *
 * Adapters name their raw unit honestly rather than flattening everything to
 * `read` — Firestore counts `read`, Mongo counts `mongo.docs_read`, Postgres
 * counts `postgres.rows_read` — because the units are genuinely different work
 * and {@link ResourceCounts} keeps them "distinct, never merged".
 *
 * The readout must therefore RESOLVE the unit rather than assume `read`.
 * Anything ending in `read`/`reads`, on a `.` or `_` boundary, is a read unit.
 */
export function isReadUnit(unit: string): boolean {
  if (NON_READ_UNITS.has(unit)) return false;
  return /(?:^|[._])reads?$/.test(unit);
}

/**
 * Total reads in one bucket, summed across EVERY read unit present.
 *
 * Pre-fix this read `counts.read` directly, so an adapter whose raw unit is not
 * literally `read` — Mongo and Postgres, both shipped — rendered 0 and the
 * readout claimed "No reads metered yet" while the data sat right there.
 * Reported by @codeCraft-Ritik (buckets-oss#14).
 */
export function readsIn(counts: ResourceCounts | undefined): number {
  if (!counts) return 0;
  let total = 0;
  for (const [unit, n] of Object.entries(counts)) {
    if (typeof n === "number" && isReadUnit(unit)) total += n;
  }
  return total;
}

/**
 * Read units that carried traffic, in the order they contributed most — so a
 * mixed-adapter surface can say WHICH reads it is totalling instead of merging
 * two different kinds of work into one anonymous number.
 */
function readUnitsPresent(report: BucketsReport): string[] {
  const totals = new Map<string, number>();
  for (const counts of Object.values(report.byLabel ?? {})) {
    for (const [unit, n] of Object.entries((counts ?? {}) as ResourceCounts)) {
      if (typeof n === "number" && n > 0 && isReadUnit(unit)) {
        totals.set(unit, (totals.get(unit) ?? 0) + n);
      }
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
}

/**
 * Units that are neither a read nor a known write — i.e. a unit this renderer
 * does not understand. Surfaced in the readout rather than silently dropped,
 * because silently dropping an unrecognised unit is precisely the defect
 * buckets-oss#14 reported: metered data that renders as "nothing here".
 */
function unrecognisedUnits(report: BucketsReport): string[] {
  const seen = new Set<string>();
  for (const counts of Object.values(report.byLabel ?? {})) {
    for (const [unit, n] of Object.entries((counts ?? {}) as ResourceCounts)) {
      if (typeof n === "number" && n > 0 && !isReadUnit(unit) && !NON_READ_UNITS.has(unit)) {
        seen.add(unit);
      }
    }
  }
  return [...seen].sort();
}

/** Render the day's coalesced report as a human/AI-readable markdown readout. */
export function renderReadout(report: BucketsReport): string {
  const entries = Object.entries(report.byLabel ?? {})
    .map(([label, counts]) => ({ label, reads: readsIn(counts as ResourceCounts) }))
    .filter((e) => e.reads > 0)
    .sort((a, b) => b.reads - a.reads);

  const total = entries.reduce((s, e) => s + e.reads, 0);
  const units = readUnitsPresent(report);
  const unknown = unrecognisedUnits(report);
  const out: string[] = [];
  out.push(`# Buckets — reads on this surface`);
  out.push(``);
  out.push(`**${fmt(total)} reads** · ${report.date} (UTC)`);
  // Name the units when more than one meter is installed. Two adapters count
  // genuinely different work (documents vs rows), and the model keeps them
  // distinct — so say which reads this total is made of rather than merging
  // them into one anonymous number.
  if (units.length > 1) {
    out.push(``);
    out.push(`_Across ${units.length} read units: ${units.join(", ")}._`);
  }
  out.push(``);

  // A unit this renderer doesn't understand is SHOWN, never dropped. Silently
  // discarding metered data is the defect buckets-oss#14 reported — the readout
  // said "nothing here" while the reads existed. It can't happen quietly again.
  if (unknown.length > 0) {
    out.push(
      `> ⚠️ Metered but not shown — unrecognised unit(s): ${unknown.join(", ")}. ` +
        `Please report this at https://github.com/Crossdeckhq/buckets-oss/issues so the readout can count them.`,
    );
    out.push(``);
  }

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
    .map(([actor, c]) => ({ actor, reads: readsIn(c as ResourceCounts) }))
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
        reads: readsIn(c as ResourceCounts),
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
