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
