/**
 * Buckets in a Firebase Functions backend — the whole setup, end to end.
 *
 *   1. init() once at module load — configure the report + install the read trap
 *   2. bucket() around the paths you want named
 *   3. open app.cross-deck.com → Buckets to watch the numbers (and name the rest)
 *
 * Run: this is illustrative — drop the two marked blocks into your own backend.
 */
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as Firestore from "firebase-admin/firestore";

import { init, bucket } from "@crossdeck/buckets";

// ── 1. Configure once, at module load (before any reads) ─────────────────────
init({
  apiKey: process.env.CROSSDECK_SECRET_KEY!, // your cd_sk_ secret key
  firestore: Firestore, // installs the universal read trap — every read now counts
});

initializeApp();
const db = getFirestore();

// ── 2. Name the read paths that matter ───────────────────────────────────────
export const home = onRequest(async (req, res) => {
  // Everything inside this bucket() — however deep the call stack — attributes
  // its reads to "home-feed". Untagged reads elsewhere still show up, labelled by
  // collection, so you can name them next.
  const posts = await bucket("home-feed", async () => {
    const snap = await db.collection("posts").orderBy("createdAt", "desc").limit(20).get();
    return snap.docs.map((d) => d.data());
  });

  res.json({ posts });
});

// A scheduled job is the classic "where did all those reads come from?" culprit —
// give it a name up front and it can never hide.
export const nightlyExport = onRequest(async (_req, res) => {
  await bucket("nightly-export", async () => {
    const all = await db.collection("events").get(); // counts as all.size reads, on "nightly-export"
    // … write the export …
    void all;
  });
  res.json({ ok: true });
});
