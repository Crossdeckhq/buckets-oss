/**
 * adapters/postgres — the Postgres read meter, mirroring the Firestore and Mongo ones.
 * Covers node-postgres (`pg`), and therefore Supabase, Neon, Vercel Postgres, RDS, and
 * plain Postgres — they all speak the same wire protocol through the same driver.
 *
 * THE RAW UNIT: Postgres's raw read unit is ROWS READ — the rows a SELECT returns,
 * attributed to the feature (bucket) that ran it. This is a real, countable number,
 * NOT a dollar bill. (Supabase/Neon/RDS bill by COMPUTE — instance size × hours, not
 * per row — so this is the read LOAD by feature: which queries pull the most rows, the
 * thing you index/narrow/paginate/cache to run a smaller instance.) Raw counts only,
 * no money — the two laws hold.
 *
 * Sourced from the official docs (the playbook's load-bearing stage), not assumed:
 *   - Supabase billing: charged purely on compute-hours, explicitly NOT per row/query
 *     (https://supabase.com/docs/guides/platform/manage-your-usage/compute) — so the
 *     honest unit is the data work, rows read, never a bill.
 *   - node-postgres Result: `result.rows` and `result.rowCount` are ALREADY present on
 *     the resolved result — reading them costs NO extra round-trip
 *     (https://node-postgres.com/apis/result) — so the meter can never be a read monster.
 *
 * THE FIX it brings: per-call-site instrumentation misses paths. Patch the driver's
 * query method ONCE, and from install on every read — anywhere, any code path, through
 * a Pool or a Client — is counted under the ambient tag with no blind spots.
 *
 * MECHANISM: we patch `Client.prototype.query` only. `Pool.query` delegates to a
 * client's `query`, so one patch catches both pool and client usage with NO double
 * count. Attribution survives because the meter runs in the CALLER's async context
 * (a `pool.query()` inside `bucket("feed")` is metered in that context) — for the
 * promise form via a synchronously-attached `.then`, and for the legacy callback form
 * via `AsyncResource.bind`. Observe-only: it counts the rows already in the result it
 * was handed — it adds NO query (no `EXPLAIN`, no `pg_stat_statements` scan), so it can
 * never become a read monster.
 *
 * SAFETY CONTRACT (it sits on your production read path): the wrapper calls the REAL
 * `query` first, counts in a try/catch that can never throw into the caller, and ALWAYS
 * returns the real result untouched. A wrong count is a measurement error, never a
 * correctness or availability one. Idempotent — calling it twice patches once.
 *
 * Pass the `Client` class from your `pg` import (an OPTIONAL peer dep — installing this
 * never forces the driver on a Firestore user):
 *
 *   import { Client } from "pg";
 *   import { installPgMeter, bucket } from "@cross-deck/buckets";
 *   installPgMeter({ Client });                       // once, at startup
 *   await bucket("billing-page", () => pool.query("SELECT ... "));
 */
import { AsyncResource } from "node:async_hooks";
import { record } from "../cost-meter";

let installed = false;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

/** Postgres's raw read unit — rows returned by a SELECT. A count. */
export const PG_READ_UNIT = "postgres.rows_read";

/**
 * The `pg` driver class to patch. Pass `Client` from your `pg` import; `Pool.query`
 * delegates to it, so this single patch covers pool usage too. Only the prototype
 * present is patched, so a driver-version mismatch degrades to "counts nothing",
 * never a crash.
 */
export interface PgClasses {
  /** node-postgres Client — `.query()` runs a statement and resolves a Result. */
  Client?: { prototype: { query?: AnyFn } };
}

/** A pg Result, minimally typed for what we read (already in hand — no round-trip). */
interface PgResultLike {
  /** The SQL command tag: "SELECT", "INSERT", … — tells a read from a write. */
  command?: string;
  /** The rows the statement returned (empty for a write with no RETURNING). */
  rows?: unknown[];
}

/**
 * Count the ROWS READ from a resolved Result — and ONLY for reads. node-postgres sets
 * `command` to the SQL command tag; a "SELECT"'s returned rows are the read load. A
 * write's RETURNING rows (command "INSERT"/"UPDATE"/"DELETE") are NOT reads and are
 * correctly excluded. PURE; never throws.
 */
function meterResult(res: PgResultLike | undefined | null): void {
  try {
    if (res && res.command === "SELECT" && Array.isArray(res.rows) && res.rows.length > 0) {
      record(PG_READ_UNIT, res.rows.length);
    }
  } catch {
    /* the meter must never throw into the caller */
  }
}

/**
 * Install the Postgres read meter on `Client.prototype.query`. Call ONCE at process
 * start, before any reads. Pass the `Client` class from your `pg` import.
 */
export function installPgMeter(classes: PgClasses): void {
  if (installed) return;
  installed = true;

  const proto = classes.Client?.prototype;
  const real = proto?.query;
  if (!proto || !real) return;

  proto.query = function (this: unknown, ...args: any[]): any {
    // The last arg MAY be a Node-style callback (the legacy form). The promise form
    // passes no callback and the driver returns a Promise<Result>.
    const last = args.length > 0 ? args[args.length - 1] : undefined;

    if (typeof last === "function") {
      // Callback form. pg invokes the callback later, from a socket event whose async
      // context is NOT the caller's — so bind the meter to the caller's context now,
      // so attribution lands under the right bucket.
      const meterHere = AsyncResource.bind((res: PgResultLike) => meterResult(res));
      args[args.length - 1] = function (this: unknown, err: unknown, res: PgResultLike) {
        if (!err) {
          try {
            meterHere(res);
          } catch {
            /* never disturb the caller */
          }
        }
        return last.apply(this, arguments as unknown as any[]);
      };
      return real.apply(this, args);
    }

    const ret = real.apply(this, args);
    // Promise form: attach `.then` synchronously, here in the caller's async context,
    // so the meter runs with that context and attribution survives.
    if (ret && typeof ret.then === "function") {
      return ret.then((res: PgResultLike) => {
        meterResult(res);
        return res;
      });
    }
    // A submittable (a Query/Cursor object) or anything unexpected — leave untouched.
    return ret;
  };
}

/** Test-only: reset the install guard so a suite can re-patch a fresh prototype. */
export function __resetPgMeterForTests(): void {
  installed = false;
}
