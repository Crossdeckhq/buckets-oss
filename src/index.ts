/**
 * @crossdeck/buckets — know exactly what every database read costs you, and who
 * caused it. A tiny, never-throws collector for Firestore.
 *
 * The whole footprint a consumer sees:
 *   1. init({ apiKey, firestore })  — configure once, install the trap once
 *   2. bucket(name, fn)             — name the read paths that matter
 *   3. (the dashboard shows the rest — and names the ones you haven't yet)
 */
import { configureMeter, type MeterConfig } from "./cost-meter.js";
import { ReportSink, type Sink } from "./sink.js";
import { installFirestoreMeter, type FirestoreClasses } from "./adapters/firestore.js";

export interface InitOptions {
  /** The project's `cd_sk_` SECRET key. Server-to-server only — never a browser key. */
  apiKey: string;
  /**
   * Pass the namespace from `firebase-admin/firestore` to auto-install the read
   * trap (recommended — this is what makes every read count with no per-call work).
   * Omit it if you'd rather call `installFirestoreMeter()` yourself, or you only
   * use the manual `recordReads()` recorders.
   */
  firestore?: FirestoreClasses;
  /** Override the report endpoint (defaults to Crossdeck's ingest). */
  endpoint?: string;
  /** How often to flush coalesced counts (ms). Default 60_000. */
  flushIntervalMs?: number;
  /** Bring your own sink (self-host the rollups). Defaults to reporting up to Crossdeck. */
  sink?: Sink;
  /** Notified when a flush fails, so a dropped window is never silent. Best-effort. */
  onError?: MeterConfig["onError"];
}

/**
 * Configure Buckets once, at process start. Points the meter at a sink (Crossdeck's
 * ingest by default) and — if you pass `firestore` — installs the universal read
 * trap so every read counts automatically.
 */
export function init(options: InitOptions): void {
  const sink = options.sink ?? new ReportSink({ apiKey: options.apiKey, endpoint: options.endpoint });
  configureMeter({ sink, flushIntervalMs: options.flushIntervalMs, onError: options.onError });
  if (options.firestore) installFirestoreMeter(options.firestore);
}

/** Alias — reads well next to `bucket()` at a call site. */
export { init as initBuckets };

// The headline verb + the lower-level tag controls it is sugar over.
export {
  bucket,
  runWithCostTag,
  enterCostTag,
  refineCostTag,
  currentCostTag,
  type CostTag,
} from "./cost-context.js";

// Manual recorders (for non-Firestore ops, or when you don't install the trap).
export {
  recordReads,
  recordWrites,
  recordDeletes,
  flush,
  type CostHint,
  type OpType,
  type MeterConfig,
} from "./cost-meter.js";

// The trap (the only datastore adapter today) + its class shape.
export { installFirestoreMeter, type FirestoreClasses } from "./adapters/firestore.js";

// The sink seam — for self-hosting rollups instead of reporting to Crossdeck.
export { ReportSink, type Sink, type BucketsReport, type OpCounts, type ReportSinkConfig } from "./sink.js";
