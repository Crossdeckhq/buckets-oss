/**
 * web/firestore — drop-in wrappers for the three Firestore client read calls.
 *
 * Swap your import source and nothing else:
 *   - import { getDoc, getDocs, onSnapshot } from "firebase/firestore"
 *   + import { getDoc, getDocs, onSnapshot } from "@cross-deck/buckets/web"
 *
 * Each wrapper calls the REAL Firestore function, counts the documents it
 * delivers (exactly what Firestore bills), labels it (your `bucket()` name, else
 * the collection), and returns the real result untouched. It can never change a
 * result or throw from the metering — same safety contract as the server trap.
 *
 * COUNTING:
 *   - getDoc        → 1 read
 *   - getDocs       → snapshot.size reads
 *   - onSnapshot    → on EVERY fire, the number of doc changes delivered
 *     (first fire = all matching docs; each update = just the changed ones —
 *     which is precisely what a listener is billed).
 */
import {
  getDoc as _getDoc,
  getDocs as _getDocs,
  onSnapshot as _onSnapshot,
} from "firebase/firestore";
import { recordWeb } from "./meter";
import { currentLabel } from "./context";

/* eslint-disable @typescript-eslint/no-explicit-any */

// The real Firestore reads have many typed overloads; we pass arguments through
// verbatim, so call them through loose aliases (the wrappers preserve behaviour).
const rawGetDoc = _getDoc as (...args: any[]) => Promise<any>;
const rawGetDocs = _getDocs as (...args: any[]) => Promise<any>;
const rawOnSnapshot = _onSnapshot as (...args: any[]) => any;

/** Best-effort collection label from a ref/query. PURE; never throws. */
function collLabel(ref: any): string {
  try {
    const path: string =
      (typeof ref?.path === "string" && ref.path) ||
      (ref?._query?.path?.segments?.join?.("/") ?? "") ||
      "";
    if (path) {
      const segs = path.split("/").filter(Boolean);
      // even segment count → document path (…/coll/id); odd → collection.
      const coll = segs.length % 2 === 0 ? segs[segs.length - 2] : segs[segs.length - 1];
      return coll ? `col:${coll}` : "uncategorized";
    }
    const segs = ref?._query?.path?.segments;
    if (Array.isArray(segs) && segs.length) return `col:${segs[segs.length - 1]}`;
  } catch {
    /* never throw from labelling */
  }
  return "uncategorized";
}

function meter(label: string, n: number): void {
  try {
    recordWeb("read", n, label);
  } catch {
    /* best-effort */
  }
}

/** Count the docs a snapshot delivers: a query's changed docs, or 1 for a doc. */
function countSnap(snap: any): number {
  try {
    if (typeof snap?.docChanges === "function") return snap.docChanges().length;
  } catch {
    /* fall through */
  }
  return 1;
}

export function getDoc(ref: any, ...rest: any[]): Promise<any> {
  const label = currentLabel() ?? collLabel(ref);
  return rawGetDoc(ref, ...rest).then((snap: any) => {
    meter(label, 1);
    return snap;
  });
}

export function getDocs(query: any, ...rest: any[]): Promise<any> {
  const label = currentLabel() ?? collLabel(query);
  return rawGetDocs(query, ...rest).then((snap: any) => {
    meter(label, typeof snap?.size === "number" ? Math.max(snap.size, 1) : 1);
    return snap;
  });
}

/**
 * onSnapshot has several overloads — (ref, observer), (ref, onNext, onError,
 * onComplete), and either of those with a leading SnapshotListenOptions. We find
 * the next-handler wherever it is (a function or `observer.next`) and wrap it to
 * count on each fire, leaving every other argument exactly as passed.
 */
export function onSnapshot(ref: any, ...args: any[]): any {
  const label = currentLabel() ?? collLabel(ref);
  const wrapNext = (fn: any) =>
    typeof fn === "function"
      ? (snap: any) => {
          meter(label, countSnap(snap));
          return fn(snap);
        }
      : fn;

  const out = args.slice();
  // Leading options object (not a function, not an observer): skip it.
  let i = 0;
  if (out[0] && typeof out[0] !== "function" && !("next" in out[0])) i = 1;

  if (out[i] && typeof out[i] === "object" && "next" in out[i]) {
    // observer form: clone with wrapped next
    out[i] = { ...out[i], next: wrapNext(out[i].next) };
  } else if (typeof out[i] === "function") {
    // callback form: wrap onNext (the first function)
    out[i] = wrapNext(out[i]);
  }

  return rawOnSnapshot(ref, ...out);
}
