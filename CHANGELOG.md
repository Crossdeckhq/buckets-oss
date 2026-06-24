# Changelog

All notable changes to `@cross-deck/buckets`. Format: [Keep a Changelog](https://keepachangelog.com/).

## [0.14.0] — 2026-06-24

### Added
- **The cross-match: reads by user × function (`setActor`).** Tell Buckets who's behind
  a request — one line, `setActor(userId)`, with the id you already have — and every read
  attributes to the person AND the function that spent it. The report gains `byActor`
  (WHO) and `byActorLabel` (WHO × WHAT) — two **independent** axes, never merged. Absent
  entirely until an actor is set (a pure-OSS install with no identity wired emits no
  noise). Reads with no person cluster under `anonymous`; background work shows as
  `machine`, still carrying its tenant. Server **and** browser (`setActor` on `/web` too).
- **WHAT is feature-first.** Reads attribute to the *operation* that spent them, resolved
  `bucket() ?? feature ?? route ?? collection` — because one page can fire six operations
  and only one is the monster.
- **`npx @cross-deck/buckets` CLI.** Prints the local readout — `Who caused the reads` and
  `Who × what` included — to the terminal. Free, offline, no account.
- **The decoupled identity bridge** (`bridgeRequest` / `registerBucketsBridge`, global
  key `__crossdeckBucketsBridge__`) so an identity layer (the Crossdeck SDK, or your own
  boundary) can drive WHO + WHAT without either package depending on the other.

### Changed
- README reframed to the correct framing — **who caused it = the identified user** (the
  0.13.0 "origin = user-vs-machine, no user dimension" wording is reversed). Serious-dev
  voice throughout. Additive and backward-compatible — `byLabel` is unchanged.

## [0.13.1] — 2026-06-24

### Docs
- **New prominent "Serverless — wrap your handlers" section.** `withBuckets` was only a
  one-line API-reference note; serverless wrapping is load-bearing for the ~99%-capture
  promise, so it's now a first-class step: the freeze-loses-counts problem in plain terms,
  the one-line `withBuckets` fix (zero added cost — uses CPU already billed, no instance
  kept awake), and the **adapter-agnostic** point — one wrap flushes the *meter*, covering
  Firestore / MongoDB / Postgres at once, never any single datastore. No code change.

## [0.13.0] — 2026-06-23

### Changed
- **Untagged reads now surface loudly as `unknown>col:x`** (was a bare `col:x`). An
  un-bucketed read can no longer be mistaken for a real bucket named after a
  collection — it lands under an explicit `unknown` bucket, env-rooted like
  everything else (`server>unknown>col:x`). Consumers parsing labels should treat a
  leading `unknown>` as the untagged marker. Applied consistently to the server
  meter and the browser (`/web`) adapter.
- **README corrected to match the schema, honestly.** Removed every per-user claim —
  the attribution tag is `{origin, feature, appId, env}` with **no user dimension**.
  "Who caused it" is the *origin* (a real user vs a machine), not a per-user
  identity. The output example is now surface-rooted and shows the loud untagged
  label. No currency anywhere — the rollup surfaces raw counts only.

### Added
- **One integration test** that exercises the whole spine against in-memory fakes
  (never a live database): env-rooted labels, raw counts (no currency token), no
  user field in the schema, nesting composes a path, and the never-throws safety
  contract (a metering failure inside the trap returns the real read untouched).
  This single test is the guard; the directive is the spec. CI stays cheap.

### Unchanged (and verified)
- `withBuckets()` serverless flush (0.12.0) — flushes in `finally` on success and
  throw, transparent, never escapes.
- Adapters (Firestore server+web, Mongo, Postgres) are observe-only: real method
  first, count in a try/catch, always return the result untouched; each measures
  its own raw unit, never cross-summed.

## [0.12.0]

### Added
- `withBuckets(handler)` — wrap a serverless handler so its counts flush before the
  container freezes (Lambda / Cloud Functions / Vercel). The env root-stamp
  (`server`/`web`) now works server-side.
