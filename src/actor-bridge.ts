/**
 * bridge — the decoupled seam between an identity layer (the Crossdeck SDK) and
 * Buckets' attribution.
 *
 * THE PROBLEM: Buckets is generic and must NOT depend on Crossdeck; the Crossdeck
 * SDK knows WHO each request is and WHAT operation/route it is, but must NOT
 * hard-depend on Buckets (a customer may run either alone). So neither imports the
 * other.
 *
 * THE SEAM: Buckets registers a setter on a well-known global key at init. The
 * identity layer (the SDK — or your own boundary code) calls that global the instant
 * it knows the request, passing { actor, feature, route }. A missing Buckets is a
 * silent no-op for the caller; a missing identity layer just means nothing is set
 * (anonymous, collection-cascade WHAT). Bundler-safe — a string global key, no
 * dynamic `import()` of an optional package.
 *
 * THE KEY IS THE CONTRACT: the same `"__crossdeckBucketsBridge__"` string is used by
 * whatever drives it. The Crossdeck SDK hardcodes it; a third party can too.
 */

/** The global contract key. Anything wanting to drive Buckets calls
 *  `globalThis["__crossdeckBucketsBridge__"]?.({ actor, feature, route })`. */
export const BUCKETS_BRIDGE_KEY = "__crossdeckBucketsBridge__";

/** What a boundary knows about a request, propagated to the read context. All
 *  optional; an unset field is left untouched (so partial knowledge is fine). */
export interface RequestContext {
  /** WHO — the identified user (the SDK's resolved identity). */
  actor?: string;
  /** WHAT (primary) — the OPERATION that caused the reads, when readable. */
  feature?: string;
  /** WHAT (secondary) — the page/route, as deducible context. */
  route?: string;
}

type BridgeFn = (ctx: RequestContext) => void;

/** Register Buckets' request-context setter on the global so an external identity
 *  layer can drive it. Called automatically by `init()`. Best-effort. */
export function registerBucketsBridge(fn: BridgeFn): void {
  try {
    (globalThis as Record<string, unknown>)[BUCKETS_BRIDGE_KEY] = fn;
  } catch {
    /* best-effort — a frozen global must never break init */
  }
}

/**
 * Drive Buckets from outside the package — what the Crossdeck SDK calls at the
 * request boundary the moment it knows the identity + operation. No-op if Buckets
 * isn't installed/initialised, so the caller never needs a Buckets dependency or a
 * null check. Exported so a host not using the SDK can wire its own boundary too.
 */
export function bridgeRequest(ctx: RequestContext): void {
  try {
    const fn = (globalThis as Record<string, unknown>)[BUCKETS_BRIDGE_KEY] as
      | BridgeFn
      | undefined;
    if (typeof fn === "function") fn(ctx);
  } catch {
    /* best-effort */
  }
}
