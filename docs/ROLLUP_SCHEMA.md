# The rollup contract

The collector counts operations in memory and, about once a minute, flushes a
**coalesced report** to its `Sink`. This is the only data Buckets ever moves. It
is a summary — never your rows, never a query, never your users' data.

This document is the versioned contract every sink produces and the Crossdeck
ingest consumes. **v1.**

## The report

```jsonc
{
  "date": "2026-06-19",                  // UTC day, "YYYY-MM-DD"
  "byLabel": {                            // bucket name → op counts (the heart)
    "home-feed":       { "read": 4120 },
    "nightly-export":  { "read": 90000 },
    "col:posts":       { "read": 217 },   // cascade: an untagged read on `posts`
    "uncategorized":   { "read": 3 }      // cascade: no name and no derivable path
  },
  "byHour": {                             // optional — UTC hour "HH" → op counts
    "07": { "read": 1200 },
    "08": { "read": 2920 }
  }
}
```

### Fields

| Field | Type | Notes |
|---|---|---|
| `date` | `string` | UTC `YYYY-MM-DD`. The day the counts belong to. |
| `byLabel` | `{ [bucket]: { read?, write?, delete? } }` | Counts per **bucket** (the name you set with `bucket()`, or a cascade label). The headline attribution. |
| `byHour` | `{ [HH]: { read?, write?, delete? } }` | Optional. Same counts split by UTC hour — the grain the "did my fix land this hour?" view stands on. |

### Counting model

- A query that returns **N** documents = **N** reads. An **empty** result still
  counts as **1** (Firestore bills a minimum of one read per query).
- A single document `get` = 1 read. `getAll(...refs)` = the number of refs.
- Writes and deletes are counted only where you record them (`recordWrites` /
  `recordDeletes`); the Firestore trap counts **reads** — the cost monster.

### The cascade — why there are never blind spots

Every counted op gets a label, always:

1. the **bucket name** you set with `bucket("…")`, else
2. the **collection** the op touched, as `col:<collection>`, else
3. `uncategorized` — a loud last resort, never silence.

So `unknown`/`col:*`/`uncategorized` is the *un-named* state, not a missing one.
The fix is one line: wrap that read path in `bucket("a-name")`.

## Additivity (the ingest side)

Every field is folded into the day's stored doc with `increment`, so many reports
a minute coalesce safely. Sending the same window twice is the one thing a sink
must not do — the meter guarantees this by snapshotting and clearing its buffer
**before** it calls the sink, and dropping (not retrying) a failed window.
