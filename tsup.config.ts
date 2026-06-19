import { defineConfig } from "tsup";

// Dual build: one bundled entry → CommonJS (dist/index.js) AND ESM
// (dist/index.mjs) + types. A SINGLE entry on purpose — the meter keeps
// module-level state (buffers, the configured sink), so everything must share
// one module instance. `installFirestoreMeter`, `bucket`, `init`, etc. are all
// re-exported from this one entry. CommonJS backends (the Firebase Functions
// default) `require` it; ESM backends `import` it. Same code, both worlds.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  treeshake: true,
});
