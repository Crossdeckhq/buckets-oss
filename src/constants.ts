/**
 * constants — shared, dependency-free Buckets values.
 *
 * The browser bundle (`@cross-deck/buckets/web`) must NOT import the Node
 * collector (it pulls in `node:async_hooks`). Anything BOTH the server and the
 * browser need — like the actor wire-format separator — lives here so each side
 * imports the SAME value. A drifting separator would split the dashboard wrong
 * for one surface; one source of truth makes that impossible.
 */

/**
 * The honest "we don't know who" cluster for reads with no identity on them.
 * Never dropped, never guessed. `byActor` only ships once a REAL (non-anonymous)
 * actor is seen, so a pure-OSS install with no identity wired emits no noise.
 */
export const ACTOR_ANON = "anonymous";

/**
 * Separator joining `actor` + `label` in a `byActorLabel` report key
 * (`"tory@biotree.bio␟server>analytics"`) — the WHO × WHAT cross-match. A printable
 * Unit-Separator glyph: distinct from the bucket-path `>` and the `col:` leaf, and
 * not something a real actor id or label contains. The dashboard splits on it.
 */
export const ACTOR_SEP = "␟";
