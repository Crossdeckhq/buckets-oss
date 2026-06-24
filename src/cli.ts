#!/usr/bin/env node
/**
 * `npx @cross-deck/buckets` — print the local Buckets readout to the terminal:
 * which FUNCTION spent the reads, and — once you've called `setActor(yourUserId)` at
 * your request boundary — which USER, with the read totals, ranked. Free, offline, no
 * account. Reads `.crossdeck/buckets.json`, which the collector's mirror writes on
 * each flush; this command just renders it.
 *
 *   npx @cross-deck/buckets            # reads ./.crossdeck/buckets.json
 *   npx @cross-deck/buckets ./path     # custom mirror dir (matches init({ mirror }))
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderReadout } from "./readout";
import { DEFAULT_MIRROR_DIR } from "./constants";
import type { BucketsReport } from "./sink";

const dir = process.argv[2] || DEFAULT_MIRROR_DIR;
const file = join(dir, "buckets.json");

if (!existsSync(file)) {
  process.stderr.write(
    `No readout at ${file}.\n` +
      `Install the collector — \`init()\` from @cross-deck/buckets — and serve some ` +
      `traffic first; it writes the readout on each flush.\n`,
  );
  process.exit(1);
}

try {
  const report = JSON.parse(readFileSync(file, "utf8")) as BucketsReport;
  process.stdout.write(renderReadout(report) + "\n");
} catch (err) {
  process.stderr.write(
    `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
