/**
 * web/context — the browser's tagging primitive.
 *
 * The Node collector rides AsyncLocalStorage to attribute reads to a bucket
 * across async fan-outs. The browser has no AsyncLocalStorage — but it doesn't
 * need one: a read (a `getDocs` call, an `onSnapshot` registration) is set up
 * SYNCHRONOUSLY, so a plain module-level "current label" captured at call time is
 * exact. `bucket(name, fn)` sets it for the synchronous body of `fn` and restores
 * it after — so the read inside picks up the name, and an `onSnapshot` listener
 * keeps that name for every future fire.
 */

let current: string | undefined;

/** The bucket name in effect right now, or undefined (→ cascade to collection). */
export function currentLabel(): string | undefined {
  return current;
}

/**
 * Attribute every read SET UP inside `fn` to the bucket `name`:
 *
 *   bucket("pulse-map", () => onSnapshot(liveQuery, render));
 *   // → that listener's reads all show as "pulse-map", forever
 */
export function bucket<T>(name: string, fn: () => T): T {
  const prev = current;
  // NESTS into a path ("analytics" > "live-feed" → "analytics>live-feed") so the
  // dashboard can drill from a coarse bucket into its parts.
  current = prev ? `${prev}>${name}` : name;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

// WHO — the identity cross-match (Buckets' moat) in the browser. A tab is ONE user,
// so unlike the bucket label (per-read, synchronous) the actor is a single
// session-level value: set it once when you know who's logged in, and every read
// for the rest of the session attributes to them. The Crossdeck web SDK calls
// `setActor` automatically from its identity layer on `identify()`.
let actorId: string | undefined;

/** Attribute every read in this browser session to the identified `id`. Call once
 *  on login/identify (the Crossdeck SDK does it for you); falsy clears to anonymous. */
export function setActor(id: string | undefined): void {
  actorId = id || undefined;
}

/** The actor in effect now, or `undefined` (→ `anonymous` at the meter). */
export function currentActor(): string | undefined {
  return actorId;
}
