/**
 * adapters/mongo — the MongoDB read meter (the trap), mirroring the Firestore one.
 *
 * THE RAW UNIT: like Firestore (a query returning N docs = N reads), MongoDB's raw
 * unit is DOCUMENTS READ — the documents each read operation returns, attributed to
 * the feature (bucket) that ran it. This is a real, countable number, NOT a dollar
 * bill. (MongoDB bills by cluster/compute, not per read — so this is the read LOAD by
 * feature: which queries pull the most documents, the thing you index/narrow/cache to
 * run a smaller cluster.) Raw counts only, no money — the two laws hold.
 *
 * THE FIX it brings: per-call-site instrumentation misses paths. Patch the driver's
 * result-returning read methods ONCE, and from install on every read — anywhere, any
 * code path — is counted under the ambient tag with no blind spots.
 *
 * MECHANISM: the wrappers run in the CALLER's own async context (a `find().toArray()`
 * inside `bucket("feed")` resolves in that context), so attribution survives with zero
 * per-call-site work. Observe-only: it counts the result already in hand — it adds NO
 * query (no `explain()`, no profiler scan), so it can never become a read monster.
 *
 * SAFETY CONTRACT (it sits on your production read path): each wrapper calls the REAL
 * method first, counts in a try/catch that can never throw into the caller, and ALWAYS
 * returns the real result untouched. A wrong count is a measurement error, never a
 * correctness or availability one. Idempotent — calling it twice patches once.
 *
 * Pass the classes from your `mongodb` import (an OPTIONAL peer dep — installing this
 * never forces the driver on a Firestore user):
 *
 *   import { FindCursor, AggregationCursor, Collection } from "mongodb";
 *   import { installMongoMeter } from "@cross-deck/buckets";
 *   installMongoMeter({ FindCursor, AggregationCursor, Collection });
 */
import { record, type CostHint } from "../cost-meter";

let installed = false;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

/** MongoDB's raw read unit — documents returned by a read operation. A count. */
export const MONGO_READ_UNIT = "mongo.docs_read";

/**
 * The `mongodb` driver classes to patch. Pass them from your `mongodb` import — only
 * the prototypes present are patched, so a driver-version mismatch degrades to
 * "counts fewer paths", never a crash.
 */
export interface MongoClasses {
  /** find() cursor — `.toArray()` resolves the matched documents. */
  FindCursor?: { prototype: { toArray?: AnyFn } };
  /** aggregate() cursor — `.toArray()` resolves the pipeline output documents. */
  AggregationCursor?: { prototype: { toArray?: AnyFn } };
  /** Collection — `.findOne()` resolves a single document (or null). */
  Collection?: { prototype: { findOne?: AnyFn } };
}

/** Best-effort `col:<collection>` cascade for an UNtagged read. PURE; never throws. */
function hintFrom(target: any): CostHint | undefined {
  try {
    // FindCursor / AggregationCursor expose `.namespace` (MongoDBNamespace); a
    // Collection exposes `.collectionName`. Either gives us the collection.
    const ns = target?.namespace;
    if (ns && typeof ns.collection === "string" && ns.collection) {
      return { collection: ns.collection };
    }
    if (typeof target?.collectionName === "string" && target.collectionName) {
      return { collection: target.collectionName };
    }
  } catch {
    /* the meter must never throw */
  }
  return undefined;
}

function meter(n: number, hint?: CostHint): void {
  try {
    if (n > 0) record(MONGO_READ_UNIT, n, hint);
  } catch {
    /* best-effort — never disturb the caller */
  }
}

/**
 * Install the MongoDB read meter on the driver's read-result methods. Call ONCE at
 * process start, before any reads. Pass the classes from your `mongodb` import.
 */
export function installMongoMeter(classes: MongoClasses): void {
  if (installed) return;
  installed = true;
  const { FindCursor, AggregationCursor, Collection } = classes;

  // find().toArray() / aggregate().toArray() — the documents the query returned.
  const patchToArray = (proto: { toArray?: AnyFn } | undefined): void => {
    const real = proto?.toArray;
    if (!real) return;
    proto!.toArray = async function (this: unknown, ...args: any[]) {
      const out = await real.apply(this, args);
      meter(Array.isArray(out) ? out.length : 0, hintFrom(this));
      return out;
    };
  };
  patchToArray(FindCursor?.prototype);
  patchToArray(AggregationCursor?.prototype);

  // findOne() — one document (or null). A found doc is 1 read; null returned nothing.
  const realFindOne = Collection?.prototype?.findOne;
  if (realFindOne) {
    Collection!.prototype.findOne = async function (this: unknown, ...args: any[]) {
      const out = await realFindOne.apply(this, args);
      meter(out == null ? 0 : 1, hintFrom(this));
      return out;
    };
  }
}

/** Test-only: reset the install guard so a suite can re-patch fresh prototypes. */
export function __resetMongoMeterForTests(): void {
  installed = false;
}
