/**
 * with-buckets — make "no read ever slips" hold on serverless.
 *
 * Buckets coalesces counts in memory and ships them on a timer (~1/min). On a
 * long-lived server that is exactly right. But serverless runtimes — AWS Lambda,
 * Google Cloud Functions / Cloud Run, Vercel — FREEZE the execution container the
 * instant your handler returns: the flush timer's clock freezes with it, and
 * `beforeExit` never fires. An invocation that finishes in under a minute would
 * have its counted reads paused and then discarded — billed by your provider,
 * invisible to Buckets. A blind spot is the one thing this library promises not
 * to have.
 *
 * `withBuckets(handler)` closes that gap. It wraps your handler so the meter is
 * FLUSHED once, in a `finally`, before the function returns — on success and on
 * throw alike (the reads happened either way). It is transparent: it forwards
 * every argument and `this`, returns the handler's value unchanged, re-throws the
 * handler's error unchanged, and — like everything else in this library — a flush
 * fault can never escape into your app.
 *
 *   // before — counts can vanish when the container freezes:
 *   export const handler = async (event) => { ...db reads... };
 *
 *   // after — every invocation's counts ship before the freeze:
 *   export const handler = withBuckets(async (event) => { ...db reads... });
 *
 *   // optionally attribute the whole invocation to one bucket:
 *   export const handler = withBuckets("nightly-export", async (event) => { ... });
 *
 * On an always-on process (a container or classic Node server that stays up) you
 * don't need this — the timer ships your counts. Reach for it at every SERVERLESS
 * entry point: scheduled jobs, queue consumers, HTTP and callable functions.
 */
import { bucket } from "./cost-context";
import { flush } from "./cost-meter";

/**
 * Any handler shape. The `any` is contained here — it never reaches a call site:
 * the overloads below capture the caller's exact `H`, so arguments, `this`, and
 * return type stay fully checked. This is the standard "wrap any function" idiom.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => any;

/** Wrap a serverless handler so its counts flush before the container freezes. */
export function withBuckets<H extends AnyHandler>(
  handler: H,
): (...args: Parameters<H>) => Promise<Awaited<ReturnType<H>>>;
/** Wrap AND attribute the whole invocation to the bucket `name`. */
export function withBuckets<H extends AnyHandler>(
  name: string,
  handler: H,
): (...args: Parameters<H>) => Promise<Awaited<ReturnType<H>>>;
export function withBuckets<H extends AnyHandler>(
  nameOrHandler: string | H,
  maybeHandler?: H,
): (...args: Parameters<H>) => Promise<Awaited<ReturnType<H>>> {
  const name = typeof nameOrHandler === "string" ? nameOrHandler : undefined;
  const handler =
    typeof nameOrHandler === "string" ? maybeHandler : nameOrHandler;

  if (typeof handler !== "function") {
    // Misuse caught at WRAP time (setup), not per request. This is the one place
    // throwing is the developer-friendly thing to do: fail fast and loud at boot
    // rather than silently hand back a wrapper that drops every invocation.
    throw new TypeError(
      "withBuckets(handler) / withBuckets(name, handler): handler must be a function",
    );
  }

  return async function (
    this: unknown,
    ...args: Parameters<H>
  ): Promise<Awaited<ReturnType<H>>> {
    try {
      const out =
        name === undefined
          ? await handler.apply(this, args)
          : await bucket(name, () => handler.apply(this, args));
      return out as Awaited<ReturnType<H>>;
    } finally {
      // Ship this invocation's counts before the container can freeze. `flush()`
      // is contractually no-throw (a sink failure drops one window via onError),
      // and this guard is defence in depth — metering must never take down the
      // app it exists to observe, and must never mask the handler's own result.
      try {
        await flush();
      } catch {
        /* swallow — never disturb the caller */
      }
    }
  };
}
