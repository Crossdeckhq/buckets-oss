# Perfect precision, zero attribution

### How a workload generating millions of unattributable database operations led the Crossdeck team to build the observability layer the modern backend was missing.

---

During pre-launch testing, we discovered a Crossdeck workload generating more than
two million database operations a day.

The cloud provider could tell us exactly how many. It could not tell us *why.*

That was the problem.

It wasn't a scale problem — there were no customers yet; the traffic was entirely
our own, a handful of internal applications we used to exercise the platform before
launch. And it wasn't really a cost problem. The immediate cost was insignificant.
**The inability to explain it was not.**

Because the moment you sit with that fact, the implication arrives on its own: if we
could not attribute a few million operations across a handful of *internal*
applications — code we wrote, running on infrastructure we controlled — we had no
hope of attributing them across the hundreds or thousands of *customer* applications
the platform was being built to serve. The number on the screen was small. The
visibility failure underneath it was not. **The problem was never the operations.
The problem was the absence of attribution.**

---

## A number you can't explain

The natural first move is to fix it. So we did what every competent engineering team
does: we formed a hypothesis, made a change, and watched.

The hypothesis was reasonable. A dashboard view looked heavier than it should be, so
we reworked how it loaded its data and shipped the change, expecting the operation
count to fall.

It didn't move.

So we formed another hypothesis. Made another change. Shipped it. Watched.

Nothing.

This is the part that doesn't make it into most engineering post-mortems, because it
isn't a clean arc of insight. It was days of this. We would reason carefully about
where the operations *must* be coming from, make a considered change to that exact
place, deploy it, and watch the number refuse to respond. Then we'd do it again. And
again — operating on conviction rather than evidence, and our conviction, it turned
out, was wrong more often than it was right.

> We weren't fixing the system. We were *guessing* at it, with a feedback loop
> measured in days and no way to confirm whether any change had done anything at all.

And then we noticed the detail that reframed everything.

We would open a particular tab and watch the operations spike violently. We would
open the *same tab* a few minutes later and watch it barely register. Same view, same
data, wildly different behaviour — with no pattern we could see. The system wasn't
just heavy. It was **non-deterministic in a dimension we had no instrument for.** Its
behaviour wasn't acting like a property of our code. It was behaving like weather.

That was the moment the real problem came into focus. It was never the two million
operations. It was that **we had no way to measure where a single one of them came
from.** Our provider could report the total, to the integer. It could not tell us
which feature, which query, which code path, or which workload was responsible for
any of it. We had **perfect precision and zero attribution.**

You cannot fix what you cannot attribute. We had been trying to, for days, and the
system had been quietly proving it couldn't be done.

---

## Why we couldn't just add logging

The obvious answer — and the one we reached for first — is to instrument the code.
Add a counter at each read site. Tag it with the feature it belongs to. Roll it up.
Now you can see where the operations go.

So we instrumented the sites we suspected. The dashboard. The heavy views. The
queries we'd been staring at for days. And we did learn something: one tile had been
issuing roughly **fifteen thousand operations on a single render** — a fan-out that
had been hiding in plain sight the entire time.

But here is the failure that taught us the most. When we tallied what our new
instrumentation could see against what the provider actually reported, an enormous
gap remained. The operations we'd been hunting on the dashboard were real — but they
were a fraction of the total. The majority of the workload was coming from a path
none of us had thought to instrument: the data-ingestion pipeline, running quietly in
the background, on a code path no human was *looking at.* It was invisible not because
it was hidden, but because we had tagged the places we were watching and missed the
place that mattered.

This is the trap, and it is structural, not a matter of diligence:

> **Engineers instrument what they are looking at. The path that's actually generating
> the load is, almost by definition, the one nobody is looking at.**

Manual instrumentation doesn't fail loudly, with an error. It fails silently, with a
number that looks complete and isn't. You can do everything right — tag carefully,
roll up cleanly, build a dashboard — and remain blind to the largest source in the
system, with no indication that you're blind. We had built exactly that, and it had
reassured us while telling us nothing.

The conclusion was uncomfortable but clear. The answer could not be *more careful
instrumentation*, because careful instrumentation was the thing that had just failed.
It had to be instrumentation that was **impossible to miss a path with** — that
didn't depend on a human remembering to add a counter, because humans demonstrably
don't.

---

## The shape of the answer

Three principles fell out of that failure, and together they became Buckets.

**Measure at the source, not at the call site.** Instead of asking every engineer to
remember to count every operation, we instrument the database driver itself, once.
From that moment, every operation on every path — the dashboard, the cron job, the
ingest pipeline, the path written next year by someone who's never heard of this
system — is counted automatically. You cannot forget to instrument a path, because you
never instrument paths at all. There is exactly one place that counts, and it sees
everything. No blind spots, by construction.

**Attribute automatically, by carrying context.** A request announces what it is the
moment it arrives — which feature, on whose behalf — and that context follows the work
through every layer it touches, no matter how deep. A request that fans out into
fifteen operations attributes all fifteen, with no parameter passed by hand and no
guesswork at the boundary. Attribution happens where the work is actually done, every
time.

**Never become the load you're measuring.** A monitor that wrote a record for every
operation it observed would generate more load than the thing it watched — the oldest
joke in observability, and a real risk here. So Buckets counts in memory and writes a
single small summary per workload roughly once a minute, no matter how many operations
it saw. The instrument is, and must be, effectively free.

With those three things in place, the two-million-operation mystery dissolved in an
afternoon. The number that had resisted us for days simply *explained itself.* The
dashboard was responsible for this much; the ingest pipeline for that much; one
specific layer of one specific view for an amount that was, once we could see it,
obviously absurd. The investigation that had eluded us for a week became a focused
day's work, because for the first time we were operating on evidence instead of
conviction.

The system had finally learned to explain itself.

---

## What we actually discovered

We set out to explain one workload. What we found was a missing category.

Every backend ever built has the exact blindness we had. Providers report with total
precision and zero attribution — they will tell you the count to the integer, and
nothing whatsoever about *why.* The industry has accepted this as normal, the way we
once accepted applications shipping without error tracking, or without analytics. You
discover an attribution problem the way we did: by noticing a number you can't
explain, and then guessing.

And the question is identical at every scale. Two million operations a day, two
hundred million, twenty billion — the only thing that changes is the size of the
number. *Which feature caused them* stays exactly as hard, and exactly as
unanswerable, whether you are a single internal workload or a platform underneath
thousands of customer applications. That is what makes it a systems problem and not a
budgeting one.

Buckets is the instrument for that blind spot. It turns *"two million operations"*
into *"this feature, on this path, on behalf of these users"* — the difference between
a number and an answer. And once you have that, an entire class of question that was
previously unanswerable becomes routine: which feature is the heaviest, which load
scales with users versus which is fixed, where exactly a change in behaviour began.

We made a deliberate decision about how to bring it to the world. **The collection
layer — the part that captures and attributes every operation — we are open-sourcing,
completely and permanently.** We are publishing the data format openly, so that anyone
can read what Buckets produces with any tool they like, including their own. We believe
measurement should be a free, shared primitive the whole ecosystem can build on — the
way error capture and event collection eventually became. No one should have to pay
simply to *see* their own system.

What sits *above* that — the layer that reads the measurements and tells you why
something moved, which deploy caused it, and what to do about it — is the product
Crossdeck builds. Telemetry is becoming a commodity, as it should. Interpretation is
where the value has always lived. Open measurement makes us the natural place to turn
measurement into answers; it does not make us the only place, and that is a stronger
and more honest position to hold.

---

## A verdict, or a warning

Picture two teams with the same regression — a query pattern that has quietly begun
generating orders of magnitude more load than it should.

The first team finds out long after the fact. Someone reviews the system at the end of
the month and sees behaviour that has been running, unexplained, for weeks. By then it
is history: the work is done, and the console offers a single undifferentiated total
with no hint of which feature produced it. Before they can fix anything, they have to
reconstruct a month-old crime scene from one number. For them, the report is a
*verdict* — final, delivered long after the fact, impossible to appeal.

The second team is told the moment it begins. A message arrives in their channel: the
analytics workload is climbing far past where it should be. Ninety seconds have
passed, not thirty days. They open the dashboard, see the load attributed to the
analytics bucket, recognise their own code, and ship the fix before the afternoon is
out. The regression that would have run for a month never gets the chance. For them,
the same event is a *warning* — delivered while it can still be prevented.

Same regression. One team absorbs it; the other never feels it. The entire difference
is *when they could attribute it* — and that timing is the one thing this kind of
tooling has never provided.

This is why operational cost has to be treated the way mature teams treat errors, not
the way they treat reports. A report is something you have to remember to open. An
error is something that comes and finds you. No engineer opens a logging dashboard
each morning hoping to stumble across a production bug; they get paged when one fires,
and they trust that if nothing fires, nothing is wrong. System load has spent its
entire history as a report nobody opens until the behaviour is already in the past.
The instrument the industry was missing doesn't merely make it *visible* — a dashboard
does that, and dashboards go unopened. It makes a regression behave like every other
failure a serious team already respects: **it pages you, while you can still do
something about it.**

And there is a quiet assumption worth making explicit, because it is the source of the
system's power. A team already knows what their code *should* do. They wrote the
analytics pipeline; they know it should generate on the order of twenty thousand
operations a day, not two million. That expectation is the baseline — brought for
free, on day one, with no model to train and no history to accumulate. The instrument's
job is not to second-guess an engineer's knowledge of their own system. It is to watch
for the moment reality departs from it, and to point, precisely, at where. The tool
does the one thing a human cannot — narrow two million undifferentiated operations to
the single feature responsible. The engineer does the one thing the tool cannot — know
what that feature was supposed to do. Neither half is magic. Together they turn a
multi-day investigation into a sixty-second triage.

---

## Why this matters now

The economics of software have quietly inverted. For a generation, the expensive part
of running a product was the engineers; the infrastructure was an afterthought.
Usage-based pricing flipped that. Today a single inefficient pattern, multiplied across
real traffic, becomes a material force in the system — and yet the capability to *find*
that pattern, to attribute load to the feature that produced it, has remained
essentially absent. We could observe our applications. We could observe our errors. We
could observe our users. The one thing we could not observe was the system's own
behaviour against the infrastructure beneath it.

We know, because we went looking for it, and there was nothing to reach for. So we
built it.

Buckets is the foundation: open, free, and already running in production on every
operation our own platform performs. It is, in the plainest terms, **the source of
truth for what a system is actually doing to the infrastructure underneath it** — the
same role Crossdeck plays for revenue, for identity, for errors. If we couldn't
explain our own system, no one building on top of it could explain theirs. Now both
can.

A system should be able to explain itself. Now it can.

---

*Buckets is built by the team at **Crossdeck** — revenue, analytics, identity, and
infrastructure observability for the people who ship modern applications.*
