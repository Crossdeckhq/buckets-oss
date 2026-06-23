# Changelog

All notable changes to `@cross-deck/buckets`. Format: [Keep a Changelog](https://keepachangelog.com/).

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
