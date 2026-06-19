# Contributing to Buckets

Thanks for being here. Buckets is small on purpose — a library that sits on a
production read path earns trust by being boring, defensive, and well-tested.

## The bar for a change

This code runs inside other people's apps, on their hot path. Every change is
measured against three non-negotiables (the safety contract in the README):

1. **It can never throw into the caller.** Every recorder and every patched method
   wraps its work in `try/catch` and always returns the real, untouched result.
2. **It can never become a cost driver.** Counts live in memory and flush ~once a
   minute. No change may add a read or a per-operation network call.
3. **No blind spots.** Every counted op gets a label — a bucket name, else
   `col:<collection>`, else `uncategorized`. Never silence.

## Getting set up

```bash
npm install
npm test        # the trust suite — must stay green
npm run build   # tsc → dist/
```

## Tests that must stay green

The suite in `tests/` is the spec, not an afterthought:

- **Flush coalescing** — N records → one report per day with correct increments.
- **The cascade** — an untagged read lands on `col:*` / `uncategorized`, never lost.
- **Never-throws** — a sink that throws leaves the app untouched; the window drops.
- **Idempotent install** — patching the trap twice patches once.
- **Empty query = 1 read** — matches billed reality.
- **Untouched result** — a wrapped read returns the exact same object.

Add a test with any behaviour change. A PR that changes counting or the wire shape
without a test will be asked for one.

## Adapters

Firestore is the only datastore adapter today. New adapters (Postgres, DynamoDB,
Mongo) follow the same shape: count at the driver, attribute to the ambient tag,
produce the rollup in `docs/ROLLUP_SCHEMA.md`. Open an issue to discuss the seam
before a large PR.

## The wire contract is versioned

`docs/ROLLUP_SCHEMA.md` is a contract shared with the Crossdeck ingest. Changing it
is a breaking change — raise it as an issue first.
