import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "../../artifacts/playwright/test-results",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["line"],
    ["json", { outputFile: "../../artifacts/playwright/report.json" }],
    ["./persistent-failure-reporter.ts"],
  ],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --host 127.0.0.1",
    cwd: "../../apps/web",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
