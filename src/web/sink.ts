/**
 * web/sink — reports the browser's coalesced rollup up to Crossdeck's ingest.
 *
 * Two differences from the Node sink, both forced by the browser:
 *  - it authenticates with a PUBLISHABLE key (`cd_pk_`), never a secret — a
 *    secret key cannot live in client code. (The ingest accepts publishable keys
 *    for Buckets reports the same way the analytics SDK accepts them for events.)
 *  - it uses `fetch(..., { keepalive: true })` so a report fired as the tab is
 *    closing still completes.
 *
 * It performs ZERO database operations — it sends a summary, it does not read.
 */
import type { BucketsReport, Sink } from "../sink";

const DEFAULT_ENDPOINT = "https://api.cross-deck.com/v1/buckets/report";

export interface WebReportSinkConfig {
  /** The project's `cd_pk_` PUBLISHABLE key. */
  apiKey: string;
  endpoint?: string;
}

export class WebReportSink implements Sink {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(config: WebReportSinkConfig) {
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    this.apiKey = config.apiKey;
  }

  async flush(report: BucketsReport): Promise<void> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      keepalive: true,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(report),
    });
    if (res.status !== 202) {
      throw new Error(`Buckets web report rejected: HTTP ${res.status}`);
    }
  }
}
