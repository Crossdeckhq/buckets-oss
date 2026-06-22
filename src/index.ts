/**
 * @cross-deck/buckets — know exactly what every database read costs you, and who
 * caused it. A tiny, never-throws collector for Firestore.
 *
 * The whole footprint a consumer sees:
 *   1. init({ apiKey, firestore })  — configure once, install the trap once
 *   2. bucket(name, fn)             — name the read paths that matter
 *   3. (the dashboard shows the rest — and names the ones you haven't yet)
 */
import { configureMeter, type MeterConfig } from "./cost-meter";
import { setDefaultSurface } from "./cost-context";
import { ReportSink, NullSink, type Sink } from "./sink";
import { MirrorSink, DEFAULT_MIRROR_DIR } from "./mirror";
import { installFirestoreMeter, type FirestoreClasses } from "./adapters/firestore";

export interface InitOptions {
  /**
   * The project's `cd_sk_` SECRET key. Server-to-server only — never a browser key.
   * OPTIONAL: with no key, Buckets still meters locally and writes the readout to
   * disk (`.crossdeck/buckets.md`) — the free, no-account wedge. Add a key and it
   * also reports up to Crossdeck so the numbers surface on your dashboard.
   */
  apiKey?: string;
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
  /**
   * Where to write the local readout — the file "read me my buckets" reads back.
   * Defaults to `.crossdeck`. Pass `false` to turn the local mirror off entirely.
   */
  mirror?: string | false;
  /** Notified when a flush fails, so a dropped window is never silent. Best-effort. */
  onError?: MeterConfig["onError"];
  /**
   * The ENVIRONMENT this collector runs in — stamped as the ROOT of every bucket
   * path so the dashboard shows server vs browser at a glance. Defaults to
   * `"server"` (this is the Node/server entry; the browser entry
   * `@cross-deck/buckets/web` defaults to `"web"`). Override only for a more
   * specific root (e.g. `"dashboard"`).
   */
  surface?: string;
}

/**
 * Configure Buckets once, at process start. Always meters locally and writes the
 * readout to disk; if you pass `apiKey` (or your own `sink`) it ALSO reports up to
 * Crossdeck. Pass `firestore` to install the universal read trap so every read counts
 * automatically.
 */
export function init(options: InitOptions = {}): void {
  // Stamp the environment root first (server entry → "server"), so every read
  // counted after this point carries its surface. A string prepend — zero reads.
  setDefaultSurface(options.surface ?? "server");
  // Upstream: your sink, else a Crossdeck reporter if a key was given, else nothing.
  const upstream: Sink | null =
    options.sink ?? (options.apiKey ? new ReportSink({ apiKey: options.apiKey, endpoint: options.endpoint }) : null);
  // Default behaviour tees every flush to a local readout; `mirror:false` opts out.
  const sink: Sink =
    options.mirror === false
      ? upstream ?? new NullSink()
      : new MirrorSink(upstream, typeof options.mirror === "string" ? options.mirror : DEFAULT_MIRROR_DIR);
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
  setDefaultSurface,
  currentSurface,
  type CostTag,
} from "./cost-context";

// Recorders. `record(resource, quantity)` is the generic adapter primitive — count
// any resource unit (a future adapter records "clickhouse.query_ms"); recordReads/
// Writes/Deletes are the Firestore conveniences over it.
export {
  record,
  recordReads,
  recordWrites,
  recordDeletes,
  flush,
  type CostHint,
  type ResourceUnit,
  type OpType,
  type MeterConfig,
} from "./cost-meter";

// The datastore traps + their class shapes. Re-exported from THIS entry so they
// share the meter's module-level state — a separate bundle would get its own meter
// instance and silently drop the counts.
export { installFirestoreMeter, type FirestoreClasses } from "./adapters/firestore";
export { installMongoMeter, type MongoClasses, MONGO_READ_UNIT } from "./mongo";
export { installPgMeter, type PgClasses, PG_READ_UNIT } from "./postgres";

// The sink seam — for self-hosting rollups instead of reporting to Crossdeck.
export {
  ReportSink,
  NullSink,
  type Sink,
  type BucketsReport,
  type ResourceCounts,
  type OpCounts,
  type ReportSinkConfig,
} from "./sink";

// The local readout — the file "read me my buckets" reads back, and its renderer.
export { MirrorSink, DEFAULT_MIRROR_DIR } from "./mirror";
export { renderReadout, READOUT_FOOTER } from "./readout";
