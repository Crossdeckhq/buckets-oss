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
}

const DEFAULT_TAG: CostTag = {};
const store = new AsyncLocalStorage<CostTag>();

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

/**
 * `bucket(name, fn)` — the headline verb, the `track()` of cost. Run `fn` with
 * every operation inside it attributed to the bucket `name`; the attribution
 * rides the async subtree automatically. The one verb most developers ever touch:
 *
 *   await bucket("nightly-export", async () => {
 *     const rows = await db.collection("events").where(...).get(); // → "nightly-export"
 *   });
 */
export function bucket<T>(name: string, fn: () => T): T {
  return runWithCostTag({ ...currentCostTag(), label: name }, fn);
}
