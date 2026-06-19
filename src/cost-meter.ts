/**
 * cost-meter — counts operations against the ambient tag and flushes them to the
 * configured Sink cheaply.
 *
 * LOW-OVERHEAD CONTRACT (the thing that warns you about reads must not run them
 * up): counts accumulate in an in-memory buffer and flush periodically — NEVER one
 * network call per counted operation. A flush coalesces the whole window into one
 * report per UTC day and hands it to the Sink. At steady state that is ~1 small
 * request a minute, regardless of how many ops you served.
 *
 * BEST-EFFORT CONTRACT: metering must never throw into your code. Every recorder
 * swallows its own errors; a failed flush drops that window's counts (surfaced via
 * `onError` if you pass one) rather than disturbing the app.
 */
import { currentCostTag } from "./cost-context";
import type { Sink, BucketsReport, ResourceCounts } from "./sink";

/**
 * A resource unit — what an adapter counts. Firestore emits `read`/`write`/
 * `delete`; other adapters emit their own (`clickhouse.query_ms`, `openai.tokens`).
 * It is a free identifier on purpose, BUT each one is kept entirely distinct: the
 * meter only ever sums quantities WITHIN a single resource, never across two.
 */
export type ResourceUnit = string;
/** @deprecated — Firestore-era name; use {@link ResourceUnit}. */
export type OpType = ResourceUnit;

/** Optional read-site hint — the collection touched, derived at the trap from the
 *  path. Lets an UNtagged read cascade to `col:<collection>` instead of vanishing. */
export interface CostHint {
  collection?: string;
  projectId?: string;
}

// NUL separator — a bucket/collection name can contain almost anything except
// this, so the key never collides with a name that has a "|" or ":" in it.
const SEP = "\u001f"; // ASCII Unit Separator

/** key = date <NUL> op <NUL> label → count */
const labelBuffer = new Map<string, number>();
/** key = date <NUL> op <NUL> hour → count */
const hourBuffer = new Map<string, number>();

let sink: Sink | null = null;
let flushIntervalMs = 60_000;
let onError: ((e: unknown) => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
/** Safety valve — flush early if a burst fills the buffer between intervals. */
const MAX_BUFFER_KEYS = 5_000;

export interface MeterConfig {
  sink: Sink;
  flushIntervalMs?: number;
  onError?: (e: unknown) => void;
}

/** Point the meter at a sink. Called by `init()`; pass your own sink to self-host. */
export function configureMeter(config: MeterConfig): void {
  sink = config.sink;
  if (config.flushIntervalMs && config.flushIntervalMs > 0) flushIntervalMs = config.flushIntervalMs;
  onError = config.onError ?? null;
}

const utcDate = (): string => new Date().toISOString().slice(0, 10);
const utcHour = (): string => new Date().toISOString().slice(11, 13);

function ensureFlushLoop(): void {
  if (timer) return;
  timer = setInterval(() => void flush(), flushIntervalMs);
  // Don't keep the event loop alive just for metering.
  (timer as { unref?: () => void }).unref?.();
  // Flush the last window on shutdown.
  process.once?.("SIGTERM", () => void flush());
  process.once?.("beforeExit", () => void flush());
}

/**
 * Count `quantity` of a `resource` against the live tag. THE adapter primitive —
 * a Firestore adapter records "read"; a ClickHouse adapter records
 * "clickhouse.query_ms"; an OpenAI adapter records "openai.tokens". Each resource
 * is bucketed entirely on its own; nothing is ever added across resources. Never
 * throws.
 */
export function record(resource: ResourceUnit, quantity: number, hint?: CostHint): void {
  try {
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const t = currentCostTag();
    const date = utcDate();
    // CASCADE — every unit gets a label, by design (no blind spots): the bucket
    // name wins; else the collection it actually touched (`col:posts`); else
    // "uncategorized" as a loud last resort. A unit is never invisible.
    const label = t.label || (hint?.collection ? `col:${hint.collection}` : "uncategorized");
    // Key includes the resource, so each resource accumulates in its OWN slot.
    const lk = date + SEP + resource + SEP + label;
    labelBuffer.set(lk, (labelBuffer.get(lk) ?? 0) + quantity);
    const hk = date + SEP + resource + SEP + utcHour();
    hourBuffer.set(hk, (hourBuffer.get(hk) ?? 0) + quantity);
    ensureFlushLoop();
    if (labelBuffer.size + hourBuffer.size > MAX_BUFFER_KEYS) void flush();
  } catch {
    /* metering is best-effort — never disturb the caller */
  }
}

/** @deprecated — use {@link record}. Firestore-era alias. */
export const recordFirestore = record;

/** Firestore bills a minimum of one read even for an empty result, so 0 counts as 1. */
export function recordReads(n: number, hint?: CostHint): void {
  record("read", Math.max(n, 1), hint);
}
export function recordWrites(n = 1): void {
  record("write", n);
}
export function recordDeletes(n = 1): void {
  record("delete", n);
}

function add(target: Record<string, ResourceCounts>, key: string, resource: ResourceUnit, n: number): void {
  const bag = (target[key] ??= {});
  // Accumulate WITHIN this resource only — never merge resources.
  bag[resource] = (bag[resource] ?? 0) + n;
}

/**
 * Coalesce the buffer into one report per UTC day and hand each to the Sink.
 * Snapshots + clears up front so concurrent records land in the next window.
 * Never throws; a sink failure drops that window (surfaced via `onError`).
 */
export async function flush(): Promise<void> {
  if (flushing) return;
  // Not configured (init not called) — drop, don't grow unbounded.
  if (!sink) {
    labelBuffer.clear();
    hourBuffer.clear();
    return;
  }
  if (labelBuffer.size === 0 && hourBuffer.size === 0) return;
  flushing = true;

  const labels = new Map(labelBuffer);
  const hours = new Map(hourBuffer);
  labelBuffer.clear();
  hourBuffer.clear();

  try {
    const byDate = new Map<string, BucketsReport>();
    const reportFor = (date: string): BucketsReport => {
      let r = byDate.get(date);
      if (!r) {
        r = { date, byLabel: {}, byHour: {} };
        byDate.set(date, r);
      }
      return r;
    };
    for (const [k, n] of labels) {
      const [date, op, label] = k.split(SEP) as [string, OpType, string];
      add(reportFor(date).byLabel, label, op, n);
    }
    for (const [k, n] of hours) {
      const [date, op, hour] = k.split(SEP) as [string, OpType, string];
      add(reportFor(date).byHour!, hour, op, n);
    }
    for (const report of byDate.values()) {
      await sink.flush(report);
    }
  } catch (e) {
    // Drop this window rather than risk a partial/double report on retry.
    onError?.(e);
  } finally {
    flushing = false;
  }
}
