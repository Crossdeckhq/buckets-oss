# Crossdeck Buckets — Developer Guide

**Status:** Foundation (collection + surfacing). No intelligence layer yet.
**Audience:** Crossdeck engineers building the two shipping parts, and external
developers who will consume the open-source collector.
**Scope of this document:** how Buckets works, why it works, the data contract,
and the exact code to be built for the two parts we are shipping now —
(1) the public open-source collector, and (2) basic raw-data surfacing in the
Crossdeck dashboard. The intelligence layer (regression detection, attribution,
forecasting) is explicitly **out of scope** here and documented separately.

---

## 1. What Buckets is

Buckets answers one question, for every billable datastore operation your backend
performs:

> **Who caused this operation, which feature served it, and which app pays for it?**

It does that continuously, with no blind spots, and — this is the part most cost
monitors get wrong — **without itself becoming a meaningful cost.**

The output is a small set of daily rollup documents. Every read, write, and delete
your backend issues is attributed to a *bucket*: a labelled slice of cost you can
reason about (`pulse-map`, `entitlement-resolve`, `analytics-dashboard`,
`people-feed`). When a number moves, you know which bucket moved and on whose
behalf.

Buckets is **telemetry, not interpretation.** It tells you *what* the costs are
and *where* they come from. It does not (yet, and not in this layer) tell you
*why* they changed or *what to do*. That distinction is deliberate and is the
governing design rule of the whole project — see §8.

---

## 1.5 Where it sits, and how the numbers travel (read this first)

Buckets is **just code that sits in the path between an application and its
database.** It does not touch the database, it does not change a query, it does not
affect a result — it observes the operations passing through and counts them. It is
therefore **database-agnostic by design**: it doesn't care whether the other side is
Firestore, Postgres, MongoDB, or DynamoDB. (Today only the **Firestore adapter** is
written; the architecture is adapter-based, so others follow the same shape. Positioning:
*the ledger between any app and any database — Firestore first.*)

**Whose numbers a dashboard shows.** A customer installs the collector in *their*
app, in *their* path to *their* database. It counts *their* reads, writes, and
deletes, and names them. **Only those numbers** surface on that customer's
dashboard — so they can see where to optimise. Nothing about what they cost
Crossdeck; nothing about Crossdeck's infrastructure. Crossdeck is the meter in the
middle and the screen that displays it.

**How the numbers travel — and why it is NOT a read monster.** This is the piece
that makes the whole thing safe at scale:

```
  customer's app ── reads / writes ──►  their database
        │  (collector counts in memory — zero reads to do its job)
        ▼   ~1 POST / minute   (a coalesced summary, NOT per-operation)
  Crossdeck ingest endpoint
        ▼
  ONE maintained doc per app per day   (overwrite/increment, not append)
        ▼
  the dashboard reads THAT ONE doc      (a precomputed number — never the
                                         customer's data, never a scan)
```

- The collector **reports a coalesced summary once a minute**, never one write per
  operation.
- Crossdeck stores **one small maintained document per app per day**.
- The dashboard renders by reading **that one document** — so surfacing a number is
  *one read of one precomputed doc*, not a scan, and never a read of the customer's
  own data.

The thing that measures operations cannot generate them. That is the founding
constraint, expressed in the deployment shape itself.

**Dogfood vs product.** Crossdeck *is* a customer of Firestore, so we run the
collector on our own backend (the path to our own `crossdeck-47d8f`) and the
dashboard shows *Crossdeck's own* operations — the genuine customer-zero view. A
real customer (e.g. a link-in-bio app on its own Firestore) installs the collector
in *its* path and sees *its* operations. Same code, two deployments. The per-tenant
"who drives Crossdeck's cost" breakdown is an internal Crossdeck view and is **not**
the product — the product is each app watching its own path.

---

## 2. Why it works — three principles

Everything in the codebase follows from three ideas. If you understand these, the
rest is mechanical.

### 2.1 Tag once at the edge, attribute at the leaf

A request sets a **cost tag** the moment it arrives. That tag rides Node's
`AsyncLocalStorage` down through every async fan-out the request triggers. So a
single pulse-map load that internally issues 15 Firestore reads attributes *all
15* to `pulse-map` — automatically, with no parameter threaded through 15 function
signatures, and no guessing at the entry point.

Attribution happens at the **leaf** (the moment a read actually executes), reading
the ambient tag — never inferred at the boundary, never hand-counted per call
site. This is the same mechanism the analytics request context already uses, so
it adds no new dependency.

### 2.2 Trap at the SDK, not at the call site

Per-call-site instrumentation (`recordRead()` sprinkled around the codebase)
**always misses paths.** We proved this on our own product: we metered the
dashboard read sites and left the entire ingest/trigger/cron path uncounted —
roughly 1.4M reads/day, the majority of total spend, invisible to the cost
utility. Humans tag what they are looking at and miss the path that matters.

The fix: patch the database SDK's read methods **once**, centrally. From install
onward, *every* read on *any* code path is counted under the ambient tag, with
zero per-call-site work. No blind spots, by construction. This is the "measure
every read like Google measures every query" guarantee.

### 2.3 Count in memory, write rarely

A monitor that wrote one document per measured operation would cost more than the
thing it measures — a self-defeating design. Instead, counts accumulate in
in-process maps and flush periodically (every ~60 seconds, or sooner under a
burst) into **one incremented document per (env, day, app)**. At steady state
that is ~1 write per minute per active app, no matter how many operations it
served. The monitor can never become the thing it monitors.

---

## 3. Architecture

Four components, in the order data flows through them. File paths refer to the
current Crossdeck implementation under `backend/src/lib/cost/`; the public repo
re-homes the same code (§6).

```
   request boundary                  every read, anywhere
        │                                     │
        ▼                                     ▼
 ┌──────────────┐   AsyncLocalStorage  ┌──────────────────┐
 │  THE TAG     │ ───────────────────▶ │   THE TRAP       │
 │ cost-context │   (ambient context)  │ firestore-read-  │
 └──────────────┘                      │   meter (SDK     │
                                       │   monkey-patch)  │
                                       └────────┬─────────┘
                                                │ recordReads(n, hint)
                                                ▼
                                       ┌──────────────────┐
                                       │   THE METER      │
                                       │   cost-meter     │
                                       │ (in-mem buffers, │
                                       │  ~60s flush)     │
                                       └────────┬─────────┘
                                                │ batched FieldValue.increment
                                                ▼
                                       ┌──────────────────┐
                                       │  THE ROLLUP DOC  │
                                       │ costRollups/     │
                                       │ {env}_{date}_    │
                                       │ {appId}          │
                                       └────────┬─────────┘
                                                │ read
                                                ▼
                                       ┌──────────────────┐
                                       │  THE SURFACE     │
                                       │ dashboard Cost   │
                                       │ view (read-only) │
                                       └──────────────────┘
```

### 3.1 The Tag — `cost-context.ts`

An `AsyncLocalStorage<CostTag>`. The tag carries four attribution fields plus one
optional sub-label:

| Field    | Type                                          | Meaning |
|----------|-----------------------------------------------|---------|
| `origin` | `runtime \| build \| internal \| unknown`      | **Does this scale with users?** `runtime` = a real user caused it (scales — the dangerous axis). `build` = us building (temporary). `internal` = housekeeping (fixed). `unknown` = un-instrumented; surfaced honestly, never silently folded in. |
| `feature`| string taxonomy                                | **Which product surface served it** (`pulse-map`, `entitlement-resolve`, `event-ingest`, …). The per-feature-economics axis. |
| `appId`  | string (`"_none"` if non-attributable)         | **Who pays.** The project the op is billed to. |
| `env`    | `production \| sandbox \| none`                | Which environment. |
| `label`  | string, optional                               | **Free-form sub-attribution within a feature** — e.g. `people-feed` (the list layer) vs `people-journey` (the click-in layer), or a procedure path. This is what makes the ledger say "people-feed read 412k, people-journey read 3k" instead of one undifferentiated "dashboard read 415k". |

Public API:
- `runWithCostTag(tag, fn)` — bind a tag for the duration of a closure (preferred at a handler wrapping body).
- `enterCostTag(tag)` — bind for the remainder of the current async context (use at the top of a handler with no wrapping closure).
- `refineCostTag(patch)` — stamp fields that resolve later (e.g. `appId` once the API key is verified), mutating the live tag so already-propagated contexts see it.
- `currentCostTag()` — the live tag, or a safe `unknown` default outside any bound context.

### 3.2 The Trap — `firestore-read-meter.ts`

`installFirestoreReadMeter(classes)` is called **once** at process start. It
patches the database SDK's read methods on their prototypes:

- `Query.prototype.get` — covers `Query` *and* `CollectionReference` (shared
  prototype method), so a collection scan is counted once with no double-count.
- `DocumentReference.prototype.get` — a single doc = 1 read.
- `Transaction.prototype.get` / `getAll` — query-or-doc, and one read per ref.
- `Firestore.prototype.getAll` — batched doc reads, one per ref.

**Counting model:** a query returning N docs = N reads. An empty result still
counts as 1 (the datastore bills a minimum of one read for an empty query — the
count must be defensible and traceable to billed operations). A document get = 1.
`getAll(...)` = the number of refs.

**The cascade hint.** Each wrapper calls `hintFrom(target)` — a pure string parse
of the read's *path* — to derive `{collection, projectId}`. This means even an
**untagged** read (one that ran outside any bound context) still attributes to a
real label (`col:events` under the right project) instead of vanishing into
"unknown". A read is never invisible.

**Safety contract — this sits on the production read path, so it is defensive by
construction.** Every wrapper:
1. calls the **real** method first and captures the result,
2. counts inside a `try/catch` that can never throw into the caller,
3. **always returns the real result, untouched.**

It physically cannot break a read, change a result, or add latency beyond one
in-memory counter increment. If a count is ever wrong, it is a *measurement*
error, never a correctness or availability one. Install is idempotent (guarded).

### 3.3 The Meter — `cost-meter.ts`

Three in-memory maps accumulate counts against the live tag:
- `opBuffer` — keyed `env|date|appId|origin|feature|opType`
- `cpuBuffer` — keyed `env|date|appId|origin|feature` → `{invocations, ms}`
- `labelBuffer` — keyed `env|date|appId|label|opType` (the per-surface breakdown)

Recorders (`recordReads`, `recordWrites`, `recordDeletes`, `recordInvocation`)
bump the maps and return. A timer flushes every `FLUSH_INTERVAL_MS` (60s); a
`MAX_BUFFER_KEYS` (5,000) safety valve flushes early under a burst; `SIGTERM` and
`beforeExit` flush the final window on instance teardown.

`flushCostMeter()` snapshots-and-clears the buffers up front (so concurrent
records land in the next window), coalesces everything into one document per
(env, day, app), and writes them in a single batch using `FieldValue.increment`
so concurrent function instances accumulate safely. A failed flush **drops that
window** (logged) rather than risk double-counting on a partial retry — cost
numbers are an observability aid, not a transactional ledger.

**The cascade rule lives here too:** every counted op gets a `byLabel` entry,
*always* — the surface `label` if set, else `col:<collection>` from the hint, else
a loud `uncategorized`. By design there is no path to a silent blind spot.

> `meteredGet(query, label)` is a convenience that reads, counts, and trips an
> operator read-breaker if the result is a runaway. The breaker is a related but
> **separable** safety device and is not part of the Buckets collection contract.

### 3.4 The Rollup Doc — the public data contract

```
costRollups/{env}_{YYYY-MM-DD}_{appId}
{
  env:       "production" | "sandbox",
  date:      "YYYY-MM-DD",          // UTC day bucket
  appId:     "proj_…",              // or "_none"
  updatedAt: <epoch ms>,

  // billable ops by who-caused-it → which-feature → op type
  ops: {
    <origin>: { <feature>: { read: <n>, write: <n>, delete: <n> } }
  },

  // function invocations + compute-ms, same attribution
  compute: {
    <origin>: { <feature>: { invocations: <n>, ms: <n> } }
  },

  // per-surface / per-layer breakdown (the free-form label axis)
  byLabel: {
    <label>: { read: <n>, write: <n>, delete: <n> }
  }
}
```

This schema **is the API.** It is documented publicly and intentionally stable.
Anything — the Crossdeck dashboard, a developer's own script, a third-party tool —
can read these documents without the library. (See §8 for why we make this open
rather than locking it down.)

### 3.5 The Surface — dashboard Cost view

`admin-cost.ts` (`getCostMetrics`) reads the `costRollups` collection, folds it in
memory, and returns totals for the dashboard. This is the *only* intelligence-free
consumer we ship now: it shows the raw, attributed numbers. No detection, no
recommendation. See §7.

---

## 4. What we are shipping (and what we are not)

We are building exactly **two** things in this phase:

1. **Part A — the open-source collector.** The tag + trap + meter + rollup,
   extracted into a standalone, provider-agnostic, public GitHub repository.
2. **Part B — basic dashboard surfacing.** A read-only Cost view in the Crossdeck
   dashboard that renders the rollup documents as plain totals, breakdowns, and a
   day-over-day table.

**Non-goals for this phase (do not build):**
- Regression / anomaly / changepoint detection.
- Deploy correlation or any causal attribution.
- Forecasting, fleet priors, savings projections.
- Suggested fixes, alerts, Slack/email, budgets.
- Any label that *interprets* (`scan-on-load`, `leak`, `regression`). The
  collector emits **primitives only** (§8).

Everything in that list is the intelligence layer, documented and built later.
Shipping it now would couple the public collector to private logic and is
explicitly forbidden by §8.

---

## 5. Part A — the open-source collector: code to be done

The Crossdeck implementation under `backend/src/lib/cost/` is the proven core.
The public repo re-homes it with three coupling points cut. None of this is new
behaviour — it is *de-Crossdecking* what already works.

### 5.1 Genericise the feature taxonomy
Today `CostFeature` is a hardcoded union of Crossdeck's own surfaces. The public
package must accept a **caller-supplied** taxonomy: a plain `string` feature with
optional runtime validation against a list the consumer registers at init. Ship
no Crossdeck-specific feature names in the box.

### 5.2 Abstract the sink
Today the meter writes directly to a Firestore `costRollups` collection. The
public package defines a **`Sink` interface** — `flush(rollups): Promise<void>` —
and ships a **Firestore adapter** as the default. This is what makes Buckets
datastore-agnostic at the *storage* layer: a consumer on Postgres writes their own
sink without touching the meter. The rollup document shape (§3.4) is the contract
every sink must produce.

### 5.3 Keep the trap as the first adapter
The SDK monkey-patch is, today, Firestore-specific. Ship it as
`adapters/firestore` — the first and only adapter at launch. Be honest in the
README that Firestore is the only supported datastore today; the trap *pattern*
generalises (pg, Dynamo, Mongo) but those are future adapters, not launch claims.

### 5.4 Public API surface (the whole package)
- `init({ apiKey, endpoint?, flushIntervalMs? })` — configure once. `apiKey` is the
  project's `cd_sk_` secret; the collector reports its rollup up to Crossdeck
  (`endpoint` defaults to `https://api.cross-deck.com/v1/buckets/report`).
- **`bucket(name, fn)`** — the headline tagging verb (the `track()` of cost): run
  `fn` with every operation inside it attributed to `name`. The ergonomic primitive
  most developers ever touch.
- `runWithCostTag`, `enterCostTag`, `refineCostTag`, `currentCostTag` — the lower-level
  tag controls `bucket()` is sugar over.
- `recordReads`, `recordWrites`, `recordDeletes`
- `installFirestoreMeter(classes)` — the Firestore trap (the only adapter today).
- `flush()` (manual flush, for tests and shutdown hooks)

One import to set up, one call to install, one verb to name a path. That is the
entire footprint a consumer sees.

### 5.5b The ingest contract (the Crossdeck side of the pipe)

The collector's flush POSTs a coalesced summary; Crossdeck receives it and writes
the one maintained rollup doc. This is the seam between the open collector and the
private platform — versioned and stable.

```
POST /v1/buckets/report          Authorization: Bearer cd_sk_…   (server-to-server)
{
  "date":  "YYYY-MM-DD",          // optional; server defaults to today (UTC)
  "byLabel": { "<bucket>": { "read": <n>, "write": <n>, "delete": <n> } },
  "byHour":  { "<HH>":     { "read": <n>, "write": <n>, "delete": <n> } }   // optional
}
→ 202 { "object": "buckets_report", "accepted": true }
```

- **Additive.** Every field is folded in with `increment`, so many reports a minute
  coalesce safely into the day's doc — `costRollups/{env}_{date}_{appId}`.
- **Read-monster-free.** This path does **zero reads**; it is ~1 small write per app
  per minute, with bounded payloads. The dashboard later reads that one doc.
- **Secret-key only.** The collector runs server-side; a publishable key is rejected.

### 5.5 The resolution loop — `unknown` → named (mirror of custom-event tagging)

This is the single most important developer-facing idea, and it must read in the
**same voice as the analytics `track-events` guide** (auto-capture is free; you
name the things that matter). The exact parallel:

| | Custom events | Buckets |
|---|---|---|
| Free, automatic | `page.viewed`, `session.started` | every read, labeled by collection (`col:events`) |
| You name it | `track("trial_started", …)` | `bucket("nightly-export", fn)` |
| Surfaces as | your named domain event | your named cost bucket |

So `unknown` is **not** a blind spot — it's the un-named state, with a one-line fix.
The loop the docs must teach explicitly: *see an `unknown` bucket → wrap that read
path in `bucket()` → ship → look again → repeat, coarse to fine, until the read is
named down to the line you care about.* Two grains, both first-class:

- **Bucket grain** (coarse): `bucket("pulse-map", handler)` — a whole surface/job.
- **Read grain** (fine): `bucket("owner-lookup", () => db.doc(id).get())` — one query.

The dashboard reinforces it: an `unknown` row is not an error state — it carries a
"tag this" affordance that shows the exact `bucket()` snippet, the same way the
analytics dashboard nudges you to fire the domain events you haven't yet. Untagged
is always actionable; the developer drives the resolution, Buckets just shows the
names filling in.

### 5.5 Repo structure
```
buckets/
├── README.md                 # the three principles, the 1.4M-reads story, quickstart
├── LICENSE                   # MIT or Apache-2.0
├── CONTRIBUTING.md
├── package.json              # semver, zero runtime deps beyond peer firebase-admin
├── src/
│   ├── cost-context.ts       # the tag (AsyncLocalStorage)
│   ├── cost-meter.ts         # buffers + flush, Sink-driven
│   ├── sink.ts               # Sink interface + rollup-doc shape
│   └── adapters/
│       └── firestore.ts      # installFirestoreMeter + Firestore sink
├── docs/
│   └── ROLLUP_SCHEMA.md      # the public data contract (§3.4), versioned
└── examples/
    └── firebase-functions/   # tag-at-edge + install-once, end to end
```

### 5.6 Tests that earn trust (an infra library lives or dies on these)
- **Flush coalescing** — N records across many keys produce one batched write per
  (env, day, app) with correct increments.
- **The cascade fallback** — an untagged read lands on `col:<collection>` /
  `uncategorized`, never silently lost.
- **The never-throws guarantee** — a sink that throws, a malformed path, a count
  failure: the wrapped read still returns the real, untouched result.
- **Idempotent install** — calling `installFirestoreMeter` twice patches once.
- **Empty-query counts as 1** — matches billed-operation reality.

### 5.7 README must lead with the safety contract
The trap monkey-patches the SDK prototype. That is the correct call for
completeness, but infra reviewers will scrutinise it. Lead the README with the
§3.2 safety contract (real-method-first, can't-throw, always-returns-untouched,
idempotent) so it reads as deliberate and careful — because it is.

---

## 6. Part B — basic dashboard surfacing: code to be done

A **read-only** Cost view. It renders what the collector produced. Nothing more.

### 6.1 Data access
A single read endpoint (the existing `getCostMetrics` is the template) that loads
the relevant `costRollups` documents for a selected env + date range and folds
them server-side. It must itself be cheap — it reads a bounded set of small daily
documents, never scans raw events. (The cost monitor's own surface must not be a
cost driver — the same rule that governs the collector.)

### 6.2 Views to render (raw numbers only)
1. **Totals** — reads / writes / deletes / invocations / compute-ms for the
   selected env + day, with a day-picker and a prior-day delta (a plain number, no
   "regression" judgement).
2. **By feature** — a sorted table/bar of reads per `feature`, the headline
   attribution.
3. **By label** — the per-surface drill-down (`byLabel`), the fine grain that
   shows which tab/layer spent the reads.
4. **By origin** — runtime vs build vs internal vs unknown, so a developer can see
   at a glance how much of their spend *scales with users*.
5. **A days table** — last N days of totals, so a human can eyeball a trend.
   (Eyeballing is fine. The system drawing the conclusion is the intelligence
   layer — not now.)

### 6.3 Explicit UI non-goals for this phase
No alerts, no badges, no "this looks wrong," no suggested fixes, no projected
savings. If a label would *interpret* the data, it belongs to the next layer.
This view is an honest mirror. (One exception is allowed and load-bearing: the
**fix marker**, below — it does not interpret the data, it lets the *developer*
mark the moment so the mirror can show before/after around it.)

### 6.4 The fix marker — the "did my fix work?" loop
The reason the meter carries **hourly** grain (`byHour`) is to close a loop the
day-grain can't: ship a change, watch it land *this hour*. The surface owns a
marker the developer sets by hand; the meter and ingest are untouched.

- **Data contract.** One tiny doc per project+env: `bucketFixMarkers/{env}_{projectId}`
  `= { env, appId, at }` where `at` is the UTC ms the developer clicked. Absent =
  no marker (a valid, common state). It is write-on-click, read-on-load — never on
  the hot path.
- **Mutations.** `markFix` stamps `at = now` (re-clicking moves it — you shipped
  again). `clearFix` deletes the doc (back to day-over-day). Both are O(1) writes,
  zero reads.
- **The verdict (reads / HOUR).** `overview` reads the marker, then splits the
  `byHour` series at `at`: `afterRate` = mean reads/hour over the complete hours
  **since** `at`; `beforeRate` = mean reads/hour over the 24h **before** it;
  `deltaPct` between them. reads/hour (not per-day) is what makes it *fast* — one
  full hour after the click is already a real datapoint, and the mean stabilises as
  more hours land. `afterRate` is `null` until the first full hour completes
  ("watching — the first hour lands soon").
- **Why a button, not a date picker.** A fix is a *moment*, not a *day*. A date
  field cannot answer "did the deploy I pushed 20 minutes ago work?"; an hourly
  before/after split at a timestamp can. The marker is the only thing the developer
  has to do, and it is one click.

This stays OSS-side: it interprets nothing, it only remembers *when you said you
changed something* and draws the line there.

---

## 6.5 The browser adapter — `@cross-deck/buckets/web` (why it exists)

**A collector counts reads where it runs.** The server trap (`installFirestoreMeter`)
captures every read through `firebase-admin` — but with Firestore, a large share of
reads often happen in the **browser**: live `onSnapshot` listeners and direct
`getDocs`/`getDoc` calls via the `firebase` JS SDK. Those bill to the project and
**never touch the server**, so a server-only collector is blind to them. We learned
this dogfooding on our own dashboard — ~94% of reads were browser-side.

The fix is a second collector, same wire contract, browser-shaped:

- **Wrappers, not a prototype trap.** The modular client SDK's reads are free
  functions, not prototype methods, so the adapter ships drop-in `getDoc`/`getDocs`/
  `onSnapshot` you import from `@cross-deck/buckets/web` instead of `firebase/firestore`.
  One import swap per file (the only extra touch vs the server's invisible trap).
- **Counting.** `getDoc` = 1; `getDocs` = `snapshot.size`; `onSnapshot` = the
  `docChanges().length` delivered on **each** fire (first fire = all matching docs;
  each update = just the changed — exactly what a listener is billed).
- **Tagging without AsyncLocalStorage.** The browser has none, and doesn't need it:
  a read is set up synchronously, so `bucket(name, fn)` uses a module-level current
  label captured at call time. An `onSnapshot` registered inside `bucket()` keeps
  that name for every future fire.
- **Reporting.** Same `Sink`/wire shape as the server. Two browser-forced changes:
  it authenticates with a **publishable** key (`cd_pub_live_` — a secret can't live in
  client code; the ingest accepts publishable keys for Buckets reports exactly as
  the analytics SDK does for events), and it flushes on `visibilitychange→hidden` /
  `pagehide` via `fetch(keepalive)` so the last window survives the tab closing.

The model is **one package, a collector per surface — install where you read.** The
"every read, no blind spots" promise is precise: every read *through a collector* is
captured; put one on each surface (server, browser) and you see all of it.

---

## 7. The governing rule: the OSS/private seam

This is the most important paragraph in the document. Read it twice.

**The collector emits primitives. It never emits interpretations.**

The labels Buckets writes are low-level and dumb on purpose: the collection
touched, the feature, the origin, the count. A label must never pre-judge —
nothing in the public rollup may say `scan-on-load`, `regression`, `leak`, or
`anomaly`. The moment a label interprets, the moat has been shipped in the
open-source box, because interpretation is the private product (the intelligence
layer).

So the seam is clean and absolute:
- **Public (this repo):** collection → the raw, honest, primitive rollup. Free,
  open-schema, anyone can read it.
- **Private (Crossdeck):** everything that *classifies* those primitives into
  meaning — and that is documented and built separately.

We publish the rollup schema openly and *embrace* third-party access to it. That
is a feature, not a risk: open collection commoditises the collection layer for
everyone (including competitors), which moves the entire field of competition onto
*interpretation* — the ground Crossdeck already owns. Openness here is an
offensive move and a trust signal at the same time. The best place to consume
Buckets data should be Crossdeck — never the only place.

---

## 7b. What Crossdeck builds on top — the alert machine (the private layer, realized)

The first interpretation product on the open buckets, and the one that earns the
seam: **Slack cost alerts.** It reads the public rollup; it lives entirely on the
private side. The whole chain — and every link reads a maintained summary, never
scans, so the thing that watches your read bill can never run one up:

1. **Hourly grain.** The collector stamps each read with its hour into the rollup's
   `byHour` map — free, a finer key in the same once-a-minute flush. This is what
   lets a developer watch a fix land *this hour* instead of next month's bill.
2. **An adaptive baseline.** An EWMA "normal" **per hour-of-day** (24 of them) per
   project, maintained one sample at a time by an hourly worker that folds the
   just-completed hour. Recency-weighted, so it *follows a fix down* and forgets the
   old start line — the baseline is descriptive ("what's normal for you now"), never
   normative ("what's good"). It is the start line, dirty or clean.
3. **Cold-start.** An hour-of-day arms only after ~7 samples (~7 days). Until then
   it **cannot** fire — we collect a baseline before we ever alert, so we never page
   a developer who just shipped a known feature.
4. **Two-gate detection.** Each completed hour is judged against its armed baseline:
   an anomaly needs **both** a k-sigma break *and* a ratio floor, so a tiny bucket
   jittering can't page anyone. A sustained, expected rise re-bases and self-silences.
5. **Slack delivery.** On a real surge: a Block Kit message via the project's own
   incoming webhook (stored in Secret Manager, preference-gated). A 6-hour cooldown
   means an ongoing spike pings **once**, not hourly.
6. **The developer stays the authority.** A one-click *"Expected — quiet for 24h"*
   suppresses while the baseline re-bases. We never pretend to know the roadmap
   better than the person who wrote it.

The statistics are unit-tested; the principle is enforced: **nothing in the alert
machine scans.** This section documents the realized layer so the full system is
legible — but every line of it is *interpretation*, and by §7 it lives on the
private side of the seam. The open collector emits primitives; this turns them into
a page-you-before-the-bill alert. That division is the moat.

---

## 8. Guarantees (the contracts a reviewer checks)

| Guarantee | Mechanism |
|-----------|-----------|
| **Every read is caught** | SDK-level trap; no read on any path is uncounted or silent. |
| **Every read is labeled** | Path-derived cascade tags collection + project even with no ambient tag. |
| **Untagged is loud, never hidden** | An untagged read lands in `unknown` origin — surfaced in the rollup + the view, never filtered out. |
| **Never a cost driver** | In-memory buffers, ~1 write/min per active app, bounded small daily docs. |
| **Never breaks a read** | Real-method-first, count-in-try/catch, always-return-untouched. |
| **Safe under concurrency** | `FieldValue.increment`; snapshot-and-clear before flush. |
| **Honest under failure** | A dropped flush loses a window, never corrupts or double-counts. |
| **Defensible counts** | Traceable to billed operations; empty query = 1 read. |
| **Stable contract** | The rollup schema is versioned and public. |

### 8.1 What "no blind spots" precisely means

The trap guarantees every read is **caught** and **labeled by collection** — none is
ever silent. Sorting a read into a *feature* and *origin* requires a tag set at the
request boundary. A read that runs outside any tagged context (a trigger, a cron, a
path nobody tagged yet) is still caught and still labeled by its collection and
project; it lands in the **`unknown`** origin until that entry point is tagged. A
rising `unknown` is the meter pointing at an un-instrumented path — the signal you
want, the opposite of a blind spot. The invariant is only this: **a read is never
uncounted.** Attribution is a spectrum (collection → project → feature → origin);
*capture* is absolute.

### 8.2 Two invariants the surface and meter MUST hold (learned the hard way)

These are not optional polish — violating either makes Buckets *lie*, which is worse
than not measuring at all:

1. **The surface never filters out `unknown` or env-less work.** A read tagged
   `env="none"` (background/untagged) is real and must appear in the origin split and
   the coverage gap. A view that drops it (`if (doc.env !== selectedEnv) continue`)
   silently hides hundreds of thousands of reads — exactly the failure this system
   exists to prevent. Filter the *runtime per-app* breakdown by env if you like;
   never filter the *coverage accounting*.

2. **The cascade treats the default/non-attributable appId as a miss.** The default
   tag's appId sentinel (e.g. `_none`) must fall through to the project derived from
   the read's path, or untagged reads pile onto a meaningless global bucket instead
   of the project in their own path. Compare against *every* non-attributable
   sentinel, not just one spelling.

---

## 9. Glossary

- **Bucket** — a labelled slice of cost: an (origin, feature, label) attribution.
- **Tag** — the request-scoped attribution context carried via AsyncLocalStorage.
- **Trap** — the one-time SDK patch that counts every read centrally.
- **Meter** — the in-memory buffer + periodic flush.
- **Rollup** — the daily per-app document; the public data contract.
- **Cascade** — the fallback that labels an untagged read by its path, never lost.
- **Sink** — the storage adapter the meter flushes to (Firestore by default).

---

*End of foundation guide. The intelligence layer — detection, attribution,
forecasting, remediation — is a separate document and a separate build, and
nothing in it may leak across the seam defined in §7.*
