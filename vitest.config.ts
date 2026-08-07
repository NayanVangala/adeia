import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // better-sqlite3 is a native module; forks keep each file's handles isolated.
    pool: "forks",
  },
});
