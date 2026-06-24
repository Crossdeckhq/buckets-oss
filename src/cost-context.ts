/**
 * cost-context — the request-scoped tag every counted operation attributes
 * itself to. Set it ONCE at a boundary (or wrap a path with `bucket()`); it
 * rides Node's AsyncLocalStorage down through every async fan-out, so one
 * handler that triggers 15 reads attributes all 15 to the same bucket — with
 * zero per-call-site work.
 *
 * Generic by design: unlike a hardcoded product taxonomy, the only meaningful
 * field a consumer sets is the free-form `label` (the bucket name). `feature`
 * is an optional coarse grouping if you want one; nothing here is
 * Crossdeck-specific.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface CostTag {
  /** Optional coarse grouping (a caller-defined surface name). */
  feature?: string;
  /** The bucket name — what `bucket()` sets. Drives the report's `byLabel`. */
  label?: string;
  /**
   * The ENVIRONMENT this read ran in — `server`, `web`, `dashboard`, … Stamped as
   * the ROOT of every bucket path so a problem bucket tells you WHERE to go fix it
   * (a backend query vs a browser listener) at a glance. Normally set once at init
   * (the server entry defaults it to `server`); override it per async-context to
   * carve a sub-surface out of one process — e.g. mark dashboard-originated reads
   * `dashboard` while background jobs stay `server`.
   */
  surface?: string;
  /**
   * WHO triggered this read — the IDENTITY cross-match, Buckets' moat. Set at the
   * request boundary: a manual `setActor()`, or AUTOMATICALLY by the Crossdeck SDK
   * from its identity layer (the resolved customer / developer user id) the moment
   * it identifies the request. Unset → the read clusters under `anonymous` (one
   * honest bucket, never dropped, never guessed). This is WHO — not why
   * (machine-vs-user) and not where (server-vs-browser) — the identified actor.
   * Only a platform that ALSO owns the SDK identity can fill it; a standalone read
   * tool never can. Scoped to the app: actors never cross tenants.
   */
  actor?: string;
}

const DEFAULT_TAG: CostTag = {};
const store = new AsyncLocalStorage<CostTag>();

/** Process-wide surface set once at init (the server entry → `server`). A per-context
 *  `surface` on the live tag overrides it for that async subtree. */
let defaultSurface: string | undefined;

/** Set the process default surface — the environment root every bucket path is
 *  stamped with. Called by `init({ surface })`; defaults to `server` there. */
export function setDefaultSurface(surface: string | undefined): void {
  defaultSurface = surface || undefined;
}

/** The surface in effect right now: an explicit per-context `surface` wins, else the
 *  process default. `undefined` until init stamps one — pre-stamp reports render under
 *  an `unknown` environment on the dashboard, never dropped. */
export function currentSurface(): string | undefined {
  return store.getStore()?.surface ?? defaultSurface;
}

/** Run `fn` with `tag` bound for its entire async subtree. */
export function runWithCostTag<T>(tag: CostTag, fn: () => T): T {
  return store.run({ ...tag }, fn);
}

/** Bind a tag for the remainder of the current async context (no closure to wrap). */
export function enterCostTag(tag: CostTag): void {
  store.enterWith({ ...tag });
}

/** Refine the live tag in place (e.g. stamp a feature after the boundary). */
export function refineCostTag(patch: Partial<CostTag>): void {
  const cur = store.getStore();
  if (cur) Object.assign(cur, patch);
}

/** The current tag, or a safe empty default outside any bound context. */
export function currentCostTag(): CostTag {
  return store.getStore() ?? DEFAULT_TAG;
}

/** Hierarchy separator for bucket paths — Firestore-map-key-safe and distinct from
 *  the "col:" leaf prefix. `bucket("a", () => bucket("b", …))` → "a>b". */
export const BUCKET_SEP = ">";

/**
 * `bucket(name, fn)` — the headline verb, the `track()` of cost. Run `fn` with
 * every operation inside it attributed to the bucket `name`; the attribution rides
 * the async subtree automatically. NESTS: a `bucket()` inside another COMPOSES into
 * a path (`"analytics" > "rollup"` → `"analytics>rollup"`), so the dashboard can
 * drill from the coarse bucket down into its parts. The one verb most developers touch:
 *
 *   await bucket("analytics", () =>
 *     bucket("rollup", () => db.collection("events").where(...).get())); // → "analytics>rollup>col:events"
 */
export function bucket<T>(name: string, fn: () => T): T {
  const parent = currentCostTag().label;
  const path = parent ? `${parent}${BUCKET_SEP}${name}` : name;
  return runWithCostTag({ ...currentCostTag(), label: path }, fn);
}

/** The unidentified-reads cluster — re-exported from the dependency-free constants
 *  so server + browser share one value. See `constants.ts`. */
export { ACTOR_ANON } from "./constants";

/**
 * `setActor(id)` — attribute every read in the current async context to the
 * identified `id` (the WHO cross-match). Call it at the request boundary the
 * instant you know who the request is for. The Crossdeck SDK calls this
 * automatically from its identity layer (resolved customer / developer user id);
 * call it yourself to light up WHO without the SDK. Rides the async subtree like
 * the rest of the tag. Falsy clears back to anonymous.
 */
export function setActor(id: string | undefined): void {
  const a = id || undefined;
  const cur = store.getStore();
  if (cur) cur.actor = a;
  else store.enterWith({ actor: a });
}

/** Scoped form — run `fn` with `id` bound as the actor for its async subtree only. */
export function withActor<T>(id: string, fn: () => T): T {
  return runWithCostTag({ ...currentCostTag(), actor: id || undefined }, fn);
}

/** The actor in effect right now, or `undefined` (→ `anonymous` at the meter). */
export function currentActor(): string | undefined {
  return store.getStore()?.actor;
}
