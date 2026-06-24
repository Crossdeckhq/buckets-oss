/**
 * @cross-deck/buckets/web — the BROWSER collector.
 *
 * Most Firebase apps read straight from the browser (live `onSnapshot`
 * listeners, `getDocs`, `getDoc`) — reads billed to your project that a
 * server-side collector can never see. This adapter closes that hole.
 *
 * Setup (two lines + one import swap):
 *
 *   import { initBucketsWeb, bucket } from "@cross-deck/buckets/web";
 *   import { getDoc, getDocs, onSnapshot } from "@cross-deck/buckets/web"; // was "firebase/firestore"
 *
 *   initBucketsWeb({ apiKey: "cd_pub_live_…" }); // your PUBLISHABLE key
 *
 *   bucket("pulse-map", () => onSnapshot(liveQuery, render));
 *
 * Every read those wrappers see is counted, labelled, and reported up the same
 * ingest pipe as the server collector — so the dashboard shows server AND browser
 * reads side by side.
 */
import { configureWebMeter, flushWeb, type WebMeterConfig } from "./meter";
import { WebReportSink } from "./sink";
import { setActor } from "./context";
import { registerBucketsBridge } from "../actor-bridge";

export interface InitWebOptions {
  /** The project's `cd_pub_live_` PUBLISHABLE key (safe in client code). */
  apiKey: string;
  /** Override the report endpoint (defaults to Crossdeck's ingest). */
  endpoint?: string;
  /** How often to flush coalesced counts (ms). Default 60_000. */
  flushIntervalMs?: number;
  /** Notified when a flush fails, so a dropped window is never silent. */
  onError?: WebMeterConfig["onError"];
  /**
   * The ENVIRONMENT this collector runs in — stamped as the ROOT of every bucket
   * path so the dashboard shows browser vs server at a glance. Defaults to `"web"`.
   * Override only for a more specific root (e.g. the Crossdeck dashboard passes
   * `"dashboard"` so its own client reads read purple, distinct from a customer app's
   * `web`).
   */
  surface?: string;
}

/** Configure the browser collector once, at app start. */
export function initBucketsWeb(options: InitWebOptions): void {
  const sink = new WebReportSink({ apiKey: options.apiKey, endpoint: options.endpoint });
  configureWebMeter({
    sink,
    flushIntervalMs: options.flushIntervalMs,
    onError: options.onError,
    surface: options.surface ?? "web",
  });
  // Open the identity seam for the browser. The Crossdeck web SDK (or your own
  // boundary) drives WHO through the same global bridge as the server — here it
  // maps to the session actor. A browser session is single-user, so the actor is
  // session-level (set on identify(), cleared on reset()), not per-request.
  registerBucketsBridge((ctx) => {
    if ("actor" in ctx) setActor(ctx.actor);
  });
}

// The tagging verb + the metered read wrappers (swap your firebase/firestore
// import for these). Cache-only reads pass through uncounted (they aren't billed).
export { bucket, setActor, currentActor } from "./context";
export { ACTOR_ANON } from "../constants";
export {
  getDoc,
  getDocs,
  onSnapshot,
  getDocFromServer,
  getDocsFromServer,
  getDocFromCache,
  getDocsFromCache,
  getCountFromServer,
  getAggregateFromServer,
} from "./firestore";
export { flushWeb as flush } from "./meter";

// The sink seam — for self-hosting the browser rollups instead of reporting to Crossdeck.
export { WebReportSink, type WebReportSinkConfig } from "./sink";
export type { BucketsReport, OpCounts, Sink } from "../sink";
