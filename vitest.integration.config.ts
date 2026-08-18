import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.integration.test.ts"],
    pool: "threads",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
