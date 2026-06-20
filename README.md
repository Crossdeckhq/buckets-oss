<div align="center">

# Buckets

### Know exactly what every database read costs you — and who caused it.

**Buckets is a zero-overhead cost attribution layer for your backend.**
Every read, write, and delete is tagged to the feature that served it and the
user who triggered it — automatically, with no blind spots, and without ever
becoming a cost itself.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-%40cross-deck%2Fbuckets-black)](https://www.npmjs.com/package/@cross-deck/buckets)
[![Firestore](https://img.shields.io/badge/datastore-Firestore-black)](#datastore-support)
[![Made by Crossdeck](https://img.shields.io/badge/made%20by-Crossdeck-black)](https://cross-deck.com)

</div>

---

## The 4am problem

You ship a feature. A week later your database bill is up 5×. Your provider's
console shows you *one number*: **9.6M reads today.** It does not tell you which
feature, which query, or which users are responsible. So you start guessing —
adding logs, bisecting deploys, staring at dashboards at 4am.

We lived this. On our own product, one tile was quietly issuing 15,000 reads
*per render*. It was hiding in plain sight for a day. When we finally instrumented
our read sites by hand, we *still* missed the path that mattered most — the
ingest pipeline, **1.4M reads a day, the majority of our entire bill, invisible.**

The lesson: **humans instrument what they're looking at, and miss the path that
matters.** Manual cost tracking doesn't fail loudly. It fails silently, and you
find out on the invoice.

Buckets fixes this by construction.

---

## Quickstart

```bash
npm install @cross-deck/buckets
```

**1. Install the meter once, at process start.** From this line on, *every*
operation on *every* code path is counted — no per-call-site work — and a coalesced
summary is reported to your Crossdeck project about once a minute. Your `cd_sk_`
secret key is all the wiring there is.

```ts
import { init, installFirestoreMeter } from "@cross-deck/buckets";
import { getFirestore, Firestore, Query, DocumentReference } from "firebase-admin/firestore";

init({ apiKey: process.env.CROSSDECK_SECRET_KEY });   // reports up to Crossdeck (~1/min)
installFirestoreMeter({ Firestore, Query, DocumentReference });   // the trap
```

That's the whole setup. The collector now sits in your path to your database,
counts in memory, and reports a tiny summary up — **it never reads your data and
never adds a query.**

**2. Name the paths that matter** with `bucket()` — every operation inside is
attributed to that name (anything you don't name still shows up, labelled by its
collection).

```ts
import { bucket } from "@cross-deck/buckets";

await bucket("pulse-map", async () => {
  const dots  = await db.collection("visitors").where("live", "==", true).get(); // → pulse-map
  const owner = await db.doc(`projects/${appId}`).get();                          // → pulse-map
});
```

**3. Read it back — right where you code.** Buckets writes a live readout to
`.crossdeck/buckets.md` (biggest bucket first). Open it, or just ask your AI session
**"read me my buckets"** — it's a plain file on disk, no dashboard required:

```
# Buckets — reads on this surface
**32K reads** · 2026-06-19 (UTC)

| bucket            | named | reads |
| ----------------- | :---: | ----: |
| headline-counters |   ✓   |   31K |
| subscriptions     |   —   |  1.1K |
```

**No Crossdeck key needed for any of that.** `init()` with no `apiKey` meters locally
and writes the readout — the free, no-account wedge. Add a key and it *also* reports
up so the same numbers surface on your dashboard, with the drill-down, before/after,
and read-spike alerts. (Set `mirror: false` to turn the local file off.)

---

## Server *and* browser — install where you read

A collector counts reads **where it runs.** With Firestore, your app often reads
from **two** places: your **server** (the snippet above) and your users'
**browsers** — live `onSnapshot` listeners and direct `getDocs`/`getDoc` calls
that bill straight to your project and *never touch your server*. A server-only
collector can't see those, the same way `@cross-deck/node` can't see a browser
event. So Buckets ships a collector for each surface.

**Browser** — swap one import and add one line:

```ts
import { initBucketsWeb, bucket } from "@cross-deck/buckets/web";
// was: import { getDocs, onSnapshot } from "firebase/firestore"
import { getDocs, onSnapshot } from "@cross-deck/buckets/web";

initBucketsWeb({ apiKey: "cd_pub_live_…" }); // your PUBLISHABLE key — safe in client code

bucket("live-feed", () => onSnapshot(liveQuery, render)); // every fire counted
```

Each listener fire is counted as the documents it delivers — exactly what Firebase
bills — labelled and reported up the **same pipe**, so your dashboard shows
**server and browser reads side by side.** Install one, or both. The promise is
precise: **Buckets captures every read that flows through a collector** — put one
on each surface you read from, and you see all of it.

> We learned this the hard way dogfooding on our own dashboard: 94% of our reads
> were browser-side and a server-only install was blind to them. The browser
> collector is the fix — and the reason "install where you read" is the whole model.

**Idempotent + React-Strict-Mode safe.** `initBucketsWeb()` only points the meter
at a sink — it never touches the count buffers (those fill from *reads*), and the
flush timer + `visibilitychange`/`pagehide` hooks sit behind one-time guards. So
calling it twice is harmless; init it wherever you init your other SDKs. One dev-only
nuance: React Strict Mode double-mounts effects, so a listener's *first* fire can be
counted twice **in dev** — production builds don't double-invoke, so your prod
numbers are exact, and your `useEffect` cleanup tears each listener down anyway.

---

## What you get

A small, cheap, daily document per app — the **rollup**. This is the entire output,
and it's a stable, public schema you can read with or without this library:

```jsonc
// costRollups/production_2026-06-18_proj_3a8f137
{
  "env": "production",
  "date": "2026-06-18",
  "appId": "proj_3a8f137",

  // who caused it → which feature → op type
  "ops": {
    "runtime":  { "pulse-map": { "read": 412000, "write": 8 },
                  "dashboard": { "read": 765000 } },
    "internal": { "reconcile": { "read": 1200, "write": 96 } }
  },

  // the fine grain: which surface / layer spent the reads
  "byLabel": {
    "people-feed":     { "read": 412000 },
    "people-journey":  { "read": 3000 },
    "col:events":      { "read": 21000 }
  }
}
```

Now "9.6M reads today" becomes *"765k of them are the dashboard, on the runtime
path — and within that, the people-feed layer is 137× heavier than the
journey-detail layer."* That's the difference between a number and an answer.

---

## "Did my fix work?" — the one-click loop

Buckets keeps reads at **hourly** grain for one reason: so you can ship a change
and *watch it land the same hour*, not guess from tomorrow's bill.

The loop:

1. You ship a fix to a heavy read path.
2. You click **I shipped a fix** on the dashboard. That stamps the exact moment.
3. Buckets splits the timeline there and shows the verdict in **reads / hour** —
   the hours *before* your fix vs the hours *after* it:

   ```
   since your fix · 2h ago
   1,240  →  310   reads / hour      −75%   930 fewer reads / hour · 2h observed
   ```

4. The first full hour after you click gives a real number; it settles as more
   hours land. No marker set yet? The header shows the plain day-over-day rate and
   a button to start the loop.

It is just a marker — a timestamp the dashboard remembers per project. Click it
again when you ship again (it moves to *now*); **clear** it to go back to the
day-over-day view. Nothing about the marker touches your read path or your bill;
it only changes where the dashboard draws the *before/after* line.

> Why a button and not a date field: a fix isn't a *day*, it's a *moment*. A date
> picker can't tell you whether the deploy you pushed twenty minutes ago worked —
> hourly before/after can.

---

## How it works

Three ideas, stacked. Understand these and you understand the whole library.

```
   request boundary                    every read, anywhere
        │                                       │
        ▼                                       ▼
 ┌──────────────┐    AsyncLocalStorage   ┌──────────────────┐
 │  ① THE TAG   │ ─────────────────────▶ │   ② THE TRAP     │
 │  tag once,   │     ambient context    │  patch the SDK   │
 │  at the edge │                        │  once, not your  │
 └──────────────┘                        │  call sites      │
                                         └────────┬─────────┘
                                                  ▼
                                         ┌──────────────────┐
                                         │  ③ THE METER     │
                                         │  count in memory,│
                                         │  flush ~1×/min   │
                                         └────────┬─────────┘
                                                  ▼
                                            the rollup doc
```

**① Tag once at the edge, attribute at the leaf.** Set the tag when a request
arrives; it propagates through every async fan-out automatically. Attribution
happens where the read *executes*, not where you guessed at the boundary.

**② Trap at the SDK, not at the call site.** Buckets patches the database driver's
read methods once. From then on every read is counted under the ambient tag — the
ingest job, the cron, the trigger, the path you forgot. **No blind spots, by
construction.** This is the part hand-rolled instrumentation can never get right.

**③ Count in memory, write rarely.** Counts accumulate in-process and flush to one
incremented document per (app, day) about once a minute — regardless of whether
you served 10 operations or 10 million. **The monitor never becomes the thing it
monitors.**

---

## Safe to put on your read path

Buckets patches your database driver. That demands a higher bar than most
libraries, so every wrapper is defensive by construction:

1. it calls the **real** method first and captures the result,
2. it counts inside a `try/catch` that **cannot throw into your code**,
3. it **always returns the real result, untouched.**

It physically cannot break a read, change a result, or add latency beyond a single
in-memory counter increment. If a count is ever wrong, it's a *measurement* error —
never a correctness or availability one. Install is idempotent. A failed flush
drops one window of counts rather than risk corrupting anything.

> Buckets is observability, not a transactional ledger. It is built to be wrong
> by a rounding error under catastrophe, and never, ever to take your app down.

| Guarantee | How |
|---|---|
| **Every read is caught** | SDK-level trap — no read on any path is ever uncounted or silent |
| **Every read is labeled** | Path-based cascade always tags the collection + project, even untagged |
| **Untagged is loud, never hidden** | Reads outside a tagged context surface as `unknown` coverage — surfaced, never dropped |
| **Never a cost driver** | In-memory buffers, ~1 write/min per app, tiny daily docs |
| **Never breaks a read** | Real-method-first · count-in-try/catch · always-return-untouched |
| **Concurrency-safe** | Atomic increments; snapshot-and-clear before each flush |
| **Honest under failure** | A dropped flush loses a window, never double-counts |

### What "no blind spots" actually means

Be precise, because the difference matters: **the trap guarantees every read is
*caught* and labeled by its collection — none is ever silent.** Sorting a read into
a *feature* and an *origin* ("this was the pulse-map, on a user's behalf") requires a
tag set at the request boundary. A read that runs outside any tagged context is
still caught and still labeled by collection (`col:events`) and project — it simply
lands in the **`unknown`** origin until you tag that entry point.

`unknown` is **first-class and loud**, never folded away and never filtered out of
the surface. A growing `unknown` bucket is the meter telling you "there's a real
read path here you haven't tagged yet" — which is exactly the signal you want, and
the opposite of a blind spot. Tag the entry point and it resolves into a named
feature. The one thing that never happens is a read going *uncounted*.

---

## From `unknown` to named — tagging

The trap catches every read for free and labels it by collection (`col:events`) —
that answers *what's being read.* Buckets becomes genuinely useful the moment you
**name the read path yourself** — wrap it in a bucket:

```ts
import { bucket } from "@cross-deck/buckets";

// every read inside here is attributed to "nightly-export"
await bucket("nightly-export", async () => {
  const rows = await db.collection("events").where("exported", "==", null).get();
  // …
});
```

From the next read on, that path reports as `nightly-export` instead of `col:events`.

> **Tagging applies going forward, not backward.** Buckets never rewrites counts
> that already happened — a count is a fact at the moment it occurs. So after you
> ship a tag you will **not** see the old `col:events` bucket rename itself. You'll
> see a **new `nightly-export` bucket appear and grow** as fresh reads land, while
> the unnamed bucket stops climbing. The next full day shows the path named from its
> first hour. (Watch for the *new* name appearing — not the old bar changing colour.)

See an `unknown` bucket you can't explain? **Drill in, wrap that path in a
`bucket()`, ship, look again** — and keep going, coarse to fine, until the read is
named all the way down to the line you care about. Two grains:

- **Tag a bucket** (coarse) — a whole handler or job: `bucket("pulse-map", handler)`
- **Tag a single read** (fine) — one query: `bucket("owner-lookup", () => db.doc(id).get())`

**Nest to drill down.** A `bucket()` inside another **composes into a path** —
the dashboard reads that path as a tree, so you tag the biggest bucket, see what's
under it, tag *that*, and the next-biggest surfaces. A tagged bucket also keeps the
collection it read as the leaf, so you never lose where the units actually went:

```ts
await bucket("analytics", () =>
  bucket("rollup", () => db.collection("events").where(/*…*/).get()));
// → "analytics > rollup > col:events"
```

That waterfall — tag, drill, tag again — is how you walk a bill down from "where's
it all going?" to the exact line, one ship at a time.

`unknown` is never a dead end. It's a to-do with a one-line fix — exactly like a
custom analytics event you haven't named yet. You tag until you've found your
source; the new names appear as fresh reads land, and the next full day starts
fully named.

---

## What Buckets is — and what it deliberately isn't

Buckets is **telemetry, done right.** It tells you *what* your costs are and
*exactly where they come from.* It does **not** tell you *why* a number changed or
*what to do about it* — and that restraint is intentional.

The labels Buckets emits are deliberately low-level: the collection, the feature,
the origin, the count. **It will never write an interpretation** — no
`scan-on-load`, no `regression`, no `anomaly`. Those are judgements, and judgement
is a separate concern that lives in a separate layer.

We think that's the honest line. Collection should be a free, open, commodity
primitive that the whole ecosystem can build on — so we open-sourced it, and we
publish the rollup schema so you can consume it with any tool you like, including
your own. **The best place to read Buckets data should be earned, never locked.**

### Free with the collector — and what Crossdeck adds

The collector is yours, free, forever: it meters every read on the surface you put
it on, never costs you reads to *run*, and you can point it at your own sink and read
the raw numbers yourself. That's a real tool on its own.

Two honest limits come with going it alone — and they're exactly what Crossdeck is for:

- **You see the surface you installed on.** Drop it in your server and you see server
  reads — often the *minority*. Most apps read from the browser too (a separate
  install), and the bill is the sum of both. **Crossdeck stitches server + browser +
  every surface into one number**, so you stop reasoning from a slice.
- **Reading the numbers back yourself costs a few reads** — querying your own stored
  rollups is still a read. **Crossdeck maintains the summary and serves it to you free,
  live, any time** — the cost tool never costs you to look.

And because it's already wired in, Crossdeck turns the raw meter into the thing you
*act* on: the **drill-down** (tag → see the next-biggest → tag again, down to the
line), the **before/after fix verdict**, a **7-day baseline**, and **Slack alerts that
page you before the invoice**. The numbers are identical on both sides — same counts,
same source — Crossdeck just makes them whole, free to read, and impossible to miss.

Getting there is one step you were taking anyway: **onboard, install the SDK once, and
read-cost comes with it** — no second setup.

### Cost should page you like an exception — not surprise you like an invoice

You already know what your code *should* do. You wrote the analytics pipeline; you
know it should read ~20k times a day, not 2M. The problem has never been a lack of
knowledge — it's that when reality departs from what you know, **nothing tells
you.** You find out at month-end, on a bill that's already due.

That's the difference between the two developers who hit the same bug. One reviews
the console at the end of the month and finds read volume that's been running ~100×
normal for weeks — a *verdict*, already billed, no cause attached. The other gets a
message ninety seconds in — *"analytics is at 2M reads, expected 20k"* — opens the
dashboard, sees which bucket, knows the code, and ships the fix before lunch. The
spike never gets a month to run. Same bug. The only difference is *when they found
out*.

A report is something you remember to open. An error is something that finds you.
Buckets gives you the open measurement that makes the difference possible — every
read attributed, in real time, with no blind spots.

### Get paged in Slack before the bill is in the post

This is the part that turns Buckets from a dashboard you remember to open into a
system that *finds you*. Connect Slack to [Crossdeck](https://cross-deck.com) and it
watches your buckets for you:

1. **It learns your normal.** For ~7 days it quietly builds a baseline of what each
   hour looks like — *per hour-of-day*, so a busy 2pm is judged against other 2pms,
   never against 3am. No alerts during this; it's collecting.
2. **It follows your fixes.** The baseline is recency-weighted: arrive bleeding 2M
   reads, fix down to 50k, and it forgets the 2M and settles at your new normal. So
   a later 50k→500k spike is a *real* deviation, not lost under an old number.
3. **It pings only on a real surge.** When a completed hour breaks the baseline (a
   big statistical jump *and* a meaningful multiple — both gates, so a tiny bucket
   jittering never pages you), you get a Slack message:
   > 🟡 **Read spike detected** — *512,000 reads* in the last hour, about *10×* your
   > normal for this time of day (~50,000). Open Buckets to see which bucket moved.
4. **You stay in control.** Shipped a feature you *know* adds reads? One click —
   **"Expected — quiet for 24h"** — and it hushes while the baseline re-bases. Your
   knowledge of your own roadmap is the final authority; it never pretends to know
   better.

An ongoing spike pings **once**, not every hour. Cold-start means it never cries
wolf before it knows you. And — the rule that holds the whole system together — the
thing that watches your read bill **never runs one up**: every check reads a small
maintained summary, never scans your data.

> The open collector in this repo produces the buckets. The baseline, the anomaly
> detection, and the Slack alert are the layer [Crossdeck](https://cross-deck.com)
> builds on top. The collector stands alone, free, forever — Crossdeck is where the
> buckets start paging you.

---

## Counting model

| Operation | Counted as |
|---|---|
| Query returning N docs | N reads |
| Empty query | 1 read *(your provider bills a minimum of one)* |
| `doc.get()` | 1 read |
| `getAll(...refs)` | one read per ref |
| `onSnapshot` fire (server + browser) | the docs that fire delivered |
| `count()` / aggregation | ~`ceil(matched / 1000)` reads *(honest estimate — Firestore doesn't expose the exact index-entry count)* |
| Write / delete | 1 each |

Counts are **defensible** — every one traces to a billed operation, so the rollup
reconciles against your provider's invoice instead of drifting from it.

---

## One model: resource units

Buckets doesn't really measure "reads and writes." It measures **resource units** —
the raw quantity of whatever a service charges you for. Firestore happens to charge
in reads, writes, and deletes, so those are its units. Other sources charge
differently, and each gets its own units:

| Source | Resource units |
|---|---|
| **Firestore** | `read`, `write`, `delete` |
| ClickHouse | `clickhouse.query_ms`, `clickhouse.bytes_scanned` |
| Redis | `redis.memory_mb` |
| Cloudflare Workers | `cloudflare.invocations` |
| OpenAI | `openai.tokens` |

Two rules keep this honest, and they are the whole of the discipline:

1. **Every resource keeps its own identity and its own unit.** A `read` is a read; a
   `clickhouse.query_ms` is a query-millisecond. They are stored and shown on
   **separate lines** and are **never added together** — there is deliberately no
   "total units" number, because adding a read to a query-millisecond is meaningless.
2. **Raw counts only — no money.** Buckets never multiplies units by a price or
   guesses a dollar figure. It tells you *how much of each unit* a feature consumed;
   you verify the cost against your provider's bill, which is the only source of
   truth for money. (Prices change by plan, region, and date; the count doesn't.)

Every adapter — present and future — does the same thing: `record(resource, quantity)`
under a `bucket()`. Same model, many sources. That's why adapters are named for the
**source**, not the database: Buckets answers *"what did feature X consume,"* and
Firestore is simply the first place it found the leak.

---

## Datastore support

| Datastore | Status |
|---|---|
| **Firestore — server** (`firebase-admin`) | ✅ Supported |
| **Firestore — browser** (`firebase` JS SDK) | ✅ Supported — `@cross-deck/buckets/web` |
| Postgres · DynamoDB · MongoDB | 🔜 Adapter interface is public — contributions welcome |

The trap *pattern* generalises to any driver with interceptable read methods, and
the storage `Sink` interface is datastore-agnostic. Firestore is the only adapter
we ship and support today — we'd rather support one datastore excellently than
five badly.

---

## API

```ts
init({ apiKey, endpoint?, flushIntervalMs? })   // configure once; reports up to Crossdeck

bucket(name, fn)               // ← the one verb you'll use: attribute everything inside to `name`

installFirestoreMeter(classes) // the Firestore trap (the only adapter today)
flush()                        // force a flush (tests / shutdown)

// lower-level, if you need it:
runWithCostTag(tag, fn) · enterCostTag(tag) · refineCostTag(patch) · currentCostTag()
recordReads(n) · recordWrites(n) · recordDeletes(n)
```

One import to set up, one call to install, one verb to name a path. That's the
whole footprint. The reporting (collector → `POST /v1/buckets/report` → your
maintained rollup → dashboard) happens automatically — you never touch it.

---

## Roadmap

- [x] Core: tag · trap · meter · rollup
- [x] Firestore adapter
- [x] Public, versioned rollup schema
- [ ] Postgres adapter
- [ ] `compute` (invocation + CPU-ms) attribution in the public build
- [ ] OpenTelemetry export
- [ ] Community sink adapters (BigQuery, ClickHouse, S3)

The *intelligence* on top of these rollups — regression detection, deploy
attribution, forecasting, suggested fixes — is **not** on this roadmap by design.
That's the line between the open primitive and the product built on it.

---

## FAQ

**Is this really free, or is there a catch?**
No catch — and that includes Crossdeck itself. The collector and the schema are
MIT, free forever; **and seeing your numbers on Crossdeck is free too**, on a
genuinely generous free tier. We never charge you to watch your own read costs —
there's no trial clock, no paywall, no "upgrade to see your data." This isn't a
funnel dressed up as open source. Your rollups are yours — in your datastore,
readable by anything, with or without us. Crossdeck earns its keep on the broader
platform you can grow into, never on locking up the cost data you already own.

**Won't patching the SDK slow down my reads?**
No. The overhead is one in-memory map increment per read. No I/O is added to the
read path; writes happen in a batched flush roughly once a minute.

**What if Buckets crashes or its sink is down?**
Your reads are unaffected — every wrapper returns the real result no matter what
happens inside the meter. You lose at most one ~60-second window of *counts*.

**Why not just read my cloud provider's billing export?**
Billing exports tell you the total. They can't tell you *which feature* or *which
user* — the attribution that lets you actually fix the cost. That's the entire
point of Buckets.

**Does it work with `firebase-functions` / serverless cold starts?**
Yes. The meter flushes on `SIGTERM` and `beforeExit`, so a scaling-to-zero
instance writes its final window before it dies.

---

## Contributing

Adapters, tests, and docs are the highest-leverage contributions. The bar for
anything touching the read path is the safety contract above — real-method-first,
never-throws, always-returns-untouched, with a test that proves it. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Who's behind this

Buckets is built and battle-tested by **[Crossdeck](https://cross-deck.com)** —
revenue, analytics, identity, and cost intelligence for app developers. We run
Buckets in production on every read our own platform serves. If it's good enough
to protect our invoice, it's good enough for yours.

## License

[MIT](LICENSE). Use it anywhere, including commercially. No attribution required
(though a ⭐ is always appreciated).

<div align="center">
<br>
<strong>Stop guessing what your database costs. Start knowing.</strong>
<br><br>
<code>npm install @cross-deck/buckets</code>
</div>
