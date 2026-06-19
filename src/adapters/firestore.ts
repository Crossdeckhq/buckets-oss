/**
 * adapters/firestore — the universal Firestore read meter (the trap).
 *
 * THE LESSON (learned on a real product): per-call-site `recordReads()`
 * instrumentation MISSES paths. You meter the read sites you're looking at and
 * leave the cron / trigger / ingest path uncounted — often the majority of reads,
 * invisible. Humans tag what they see and miss the path that matters.
 *
 * THE FIX: patch the admin SDK's read methods ONCE. From install onward, EVERY
 * read — anywhere, on any code path — is counted under the ambient tag, with zero
 * per-call-site work and no blind spots.
 *
 * SAFETY CONTRACT — this sits on your production read path, so it is defensive by
 * construction. Each wrapper:
 *   1. calls the REAL method first and captures the result,
 *   2. counts in a try/catch that can never throw into the caller,
 *   3. ALWAYS returns the real result, untouched.
 * It cannot break a read, change a result, or add latency beyond one in-memory
 * counter increment. A wrong count is a measurement error, never a correctness or
 * availability one. Idempotent — calling it twice patches once.
 *
 * COUNTING MODEL — a query returning N docs = N reads (an empty result still bills
 * 1, which the meter enforces). A document get = 1. getAll(...) = the ref count.
 * CollectionReference.get IS Query.get (shared prototype method), so patching Query
 * covers collections with no double-count.
 */
import { recordReads, type CostHint } from "../cost-meter";

let installed = false;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

/**
 * The firebase-admin Firestore classes to patch. Pass the module namespace from
 * `firebase-admin/firestore` — only the prototypes present are patched.
 */
export interface FirestoreClasses {
  Query?: { prototype: { get?: AnyFn; onSnapshot?: AnyFn } };
  DocumentReference?: { prototype: { get?: AnyFn; onSnapshot?: AnyFn } };
  Transaction?: { prototype: { get?: AnyFn; getAll?: AnyFn } };
  Firestore?: { prototype: { getAll?: AnyFn } };
  /** count() / sum() / average() — aggregation queries bill reads too. */
  AggregateQuery?: { prototype: { get?: AnyFn } };
}

/** `projects/{id}/…` → the project id, else undefined. Pure string op. */
function projectFromPath(path: string): string | undefined {
  const parts = path.split("/");
  const i = parts.indexOf("projects");
  return i >= 0 && parts[i + 1] ? parts[i + 1] : undefined;
}

/**
 * Derive { collection, projectId } from the read target's path so an UNtagged read
 * cascades to `col:<collection>` instead of "uncategorized". PURE CPU; never reads,
 * never throws. Falls back to firebase-admin's internal `_queryOptions` for filtered
 * queries (which don't expose `.path`).
 */
function hintFrom(target: any): CostHint | undefined {
  try {
    const p = typeof target?.path === "string" ? target.path : "";
    if (p) {
      const parts = p.split("/").filter(Boolean);
      const collection = parts.length % 2 === 0 ? parts[parts.length - 2] : parts[parts.length - 1];
      return { collection, projectId: projectFromPath(p) };
    }
    const qo = target?._queryOptions;
    if (qo) {
      const collection = typeof qo.collectionId === "string" ? qo.collectionId : undefined;
      const parent =
        typeof qo.parentPath?.relativeName === "string"
          ? qo.parentPath.relativeName
          : typeof qo.parentPath?.toString === "function"
            ? String(qo.parentPath.toString())
            : "";
      return { collection, projectId: parent ? projectFromPath(parent) : undefined };
    }
  } catch {
    /* the meter must never throw */
  }
  return undefined;
}

function meterSnap(snap: unknown, hint?: CostHint): void {
  try {
    const size = (snap as { size?: number } | null)?.size;
    recordReads(typeof size === "number" ? size : 1, hint);
  } catch {
    /* best-effort */
  }
}
function meterCount(n: number, hint?: CostHint): void {
  try {
    recordReads(n, hint);
  } catch {
    /* best-effort */
  }
}

/**
 * Install the universal read meter on the firebase-admin Firestore classes. Call
 * ONCE at process start, before any reads. Pass the namespace from
 * `firebase-admin/firestore` so the exact prototypes the SDK uses are patched:
 *
 *   import * as Firestore from "firebase-admin/firestore";
 *   installFirestoreMeter(Firestore);
 */
export function installFirestoreMeter(classes: FirestoreClasses): void {
  if (installed) return;
  installed = true;
  const { Query, DocumentReference, Transaction, Firestore, AggregateQuery } = classes;

  // Query.get — covers Query AND CollectionReference (shared prototype method).
  const qGet = Query?.prototype?.get;
  if (qGet) {
    Query!.prototype.get = async function (this: unknown, ...args: any[]) {
      const snap = await qGet.apply(this, args);
      meterSnap(snap, hintFrom(this));
      return snap;
    };
  }

  // DocumentReference.get — a single doc = 1 read.
  const dGet = DocumentReference?.prototype?.get;
  if (dGet) {
    DocumentReference!.prototype.get = async function (this: unknown, ...args: any[]) {
      const snap = await dGet.apply(this, args);
      meterCount(1, hintFrom(this));
      return snap;
    };
  }

  // Transaction.get — query or doc; size when present, else 1.
  const tGet = Transaction?.prototype?.get;
  if (tGet) {
    Transaction!.prototype.get = async function (this: unknown, ...args: any[]) {
      const res = await tGet.apply(this, args);
      meterSnap(res, hintFrom(args[0]));
      return res;
    };
  }

  // Transaction.getAll(...refs) — one read per ref.
  const tGetAll = Transaction?.prototype?.getAll;
  if (tGetAll) {
    Transaction!.prototype.getAll = async function (this: unknown, ...args: any[]) {
      const res = await tGetAll.apply(this, args);
      meterCount(Array.isArray(res) ? res.length : args.length || 1, hintFrom(args[0]));
      return res;
    };
  }

  // Firestore.getAll(...refs) — batched doc reads.
  const fGetAll = Firestore?.prototype?.getAll;
  if (fGetAll) {
    Firestore!.prototype.getAll = async function (this: unknown, ...args: any[]) {
      const res = await fGetAll.apply(this, args);
      meterCount(Array.isArray(res) ? res.length : args.length || 1, hintFrom(args[0]));
      return res;
    };
  }

  // AggregateQuery.get — count() / sum() / average(). Firestore bills one read per
  // up to 1000 index entries scanned, and the client never sees that entry count —
  // so this is an HONEST ESTIMATE: for count() we derive it from the result
  // (ceil(count / 1000)), else the billed minimum of 1. Observe-only: it reads the
  // result you already got, adds zero reads. (Closes the aggregation blind spot.)
  const aGet = AggregateQuery?.prototype?.get;
  if (aGet) {
    AggregateQuery!.prototype.get = async function (this: unknown, ...args: any[]) {
      const snap = await aGet.apply(this, args);
      try {
        const data = (snap as { data?: () => { count?: number } } | null)?.data?.();
        const count = typeof data?.count === "number" ? data.count : 0;
        meterCount(Math.max(1, Math.ceil(count / 1000)), hintFrom(this));
      } catch {
        /* best-effort */
      }
      return snap;
    };
  }

  // Query.onSnapshot / DocumentReference.onSnapshot — server-side realtime
  // listeners. We OBSERVE: wrap onNext and count the docs each fire delivers (a
  // query's changed docs — first fire = all matching; a doc = 1). We attach no
  // listener and issue no read; the meter just sees what the listener is already
  // billed. (Closes the server-listener blind spot.)
  const patchOnSnapshot = (proto: { onSnapshot?: AnyFn } | undefined, perDoc: boolean): void => {
    const real = proto?.onSnapshot;
    if (!real) return;
    proto!.onSnapshot = function (this: unknown, ...args: any[]) {
      const hint = hintFrom(this);
      const i = args.findIndex((a) => typeof a === "function");
      if (i >= 0) {
        const onNext = args[i];
        args[i] = function (snap: any) {
          try {
            const n = perDoc
              ? 1
              : typeof snap?.docChanges === "function"
                ? snap.docChanges().length
                : typeof snap?.size === "number"
                  ? snap.size
                  : 1;
            if (n > 0) meterCount(n, hint);
          } catch {
            /* best-effort */
          }
          return onNext(snap);
        };
      }
      return real.apply(this, args);
    };
  };
  patchOnSnapshot(Query?.prototype, false);
  patchOnSnapshot(DocumentReference?.prototype, true);
}

/** Test-only: reset the install guard so a suite can re-patch fresh prototypes. */
export function __resetFirestoreMeterForTests(): void {
  installed = false;
}
