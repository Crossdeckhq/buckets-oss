/**
 * web/meter — the browser read meter. Same contract as the Node meter (count in
 * memory, flush ~1/min, never throw into the app), adapted to the browser:
 *
 *  - no AsyncLocalStorage — labels come from web/context (synchronous),
 *  - "shutdown" is the tab going hidden/closed, so we also flush on
 *    visibilitychange→hidden and pagehide (a `fetch(..., {keepalive:true})`
 *    survives the unload),
 *  - it talks to a Sink exactly like the Node meter, so the wire shape is
 *    identical and the same ingest receives both.
 */
import type { Sink, BucketsReport, OpCounts } from "../sink";

// A resource unit. The browser Firestore adapter records "read"; kept generic so
// each resource stays distinct and is never merged with another.
export type OpType = string;

// ASCII Unit Separator — a bucket/collection name never contains it, so the
// composite key splits back cleanly.
const SEP = "\u001f"; // ASCII Unit Separator

/** key = date <US> op <US> label → count */
const labelBuffer = new Map<string, number>();
/** key = date <US> op <US> hour → count */
const hourBuffer = new Map<string, number>();

let sink: Sink | null = null;
let flushIntervalMs = 60_000;
let onError: ((e: unknown) => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let lifecycleBound = false;
const MAX_BUFFER_KEYS = 5_000;

export interface WebMeterConfig {
  sink: Sink;
  flushIntervalMs?: number;
  onError?: (e: unknown) => void;
}

export function configureWebMeter(config: WebMeterConfig): void {
  sink = config.sink;
  if (config.flushIntervalMs && config.flushIntervalMs > 0) flushIntervalMs = config.flushIntervalMs;
  onError = config.onError ?? null;
}

const utcDate = (): string => new Date().toISOString().slice(0, 10);
const utcHour = (): string => new Date().toISOString().slice(11, 13);

function ensureLoop(): void {
  if (timer) return;
  timer = setInterval(() => void flushWeb(), flushIntervalMs);
  if (!lifecycleBound && typeof addEventListener === "function") {
    lifecycleBound = true;
    // The tab being hidden or torn down is the browser's "shutdown" — flush the
    // last window. keepalive on the sink's fetch lets it complete during unload.
    addEventListener("visibilitychange", () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") void flushWeb();
    });
    addEventListener("pagehide", () => void flushWeb());
  }
}

/** Count `n` ops of `op` against `label`. Never throws. */
export function recordWeb(op: OpType, n: number, label: string): void {
  try {
    if (!Number.isFinite(n) || n <= 0) return;
    const date = utcDate();
    const lk = date + SEP + op + SEP + label;
    labelBuffer.set(lk, (labelBuffer.get(lk) ?? 0) + n);
    const hk = date + SEP + op + SEP + utcHour();
    hourBuffer.set(hk, (hourBuffer.get(hk) ?? 0) + n);
    ensureLoop();
    if (labelBuffer.size + hourBuffer.size > MAX_BUFFER_KEYS) void flushWeb();
  } catch {
    /* metering is best-effort — never disturb the page */
  }
}

function add(target: Record<string, OpCounts>, key: string, op: OpType, n: number): void {
  const bag = (target[key] ??= {});
  bag[op] = (bag[op] ?? 0) + n;
}

/** Coalesce the buffer into one report per UTC day and hand each to the Sink. */
export async function flushWeb(): Promise<void> {
  if (flushing) return;
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
    onError?.(e);
  } finally {
    flushing = false;
  }
}
