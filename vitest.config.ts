import { defineConfig } from "vitest/config";

export default defineConfig({
  // Source uses NodeNext-style ".js" import specifiers that point at ".ts" files;
  // map them so the suite resolves the same graph the published package ships.
  resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
