/**
 * sink — where the meter sends a coalesced rollup, and the wire shape it sends.
 *
 * Abstracting the sink is what makes Buckets storage-agnostic: the meter never
 * knows where counts go. The DEFAULT sink (`ReportSink`) reports up to Crossdeck's
 * ingest endpoint so the numbers surface on your Crossdeck dashboard. A team that
 * wants to self-host can implement `Sink` against anything (Postgres, a file, your
 * own API) without touching the meter.
 */

export interface OpCounts {
  read?: number;
  write?: number;
  delete?: number;
}

/**
 * One coalesced report — the wire contract (see docs/ROLLUP_SCHEMA.md). The meter
 * produces one of these per UTC day in a flush window (usually exactly one).
 */
export interface BucketsReport {
  /** UTC day "YYYY-MM-DD". */
  date: string;
  /** bucket name → counts. The heart of the report. */
  byLabel: Record<string, OpCounts>;
  /** UTC hour "HH" → counts, for the hourly "did my fix land this hour?" view. */
  byHour?: Record<string, OpCounts>;
}

/**
 * A destination for coalesced rollups. `flush` MAY throw on failure — the meter
 * catches it, drops that one window, and never lets it reach your app.
 */
export interface Sink {
  flush(report: BucketsReport): Promise<void>;
}

export interface ReportSinkConfig {
  /** The project's `cd_sk_` secret key. Server-to-server only. */
  apiKey: string;
  /** Defaults to https://api.cross-deck.com/v1/buckets/report */
  endpoint?: string;
  /** Request timeout (ms); a slow Crossdeck must never stall your flush. */
  timeoutMs?: number;
}

const DEFAULT_ENDPOINT = "https://api.cross-deck.com/v1/buckets/report";

/**
 * The default sink: POST one coalesced rollup to Crossdeck's ingest endpoint.
 * The ingest folds it into the day's maintained doc with `increment`, so many
 * reports a minute coalesce safely. This path does ZERO database reads — it sends
 * a summary, it does not read. Throws on a non-202 so the meter can log/drop the
 * window; the meter guarantees it never reaches your app.
 */
export class ReportSink implements Sink {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: ReportSinkConfig) {
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  async flush(report: BucketsReport): Promise<void> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(report),
    });
    if (res.status !== 202) {
      throw new Error(`Buckets report rejected: HTTP ${res.status}`);
    }
  }
}
