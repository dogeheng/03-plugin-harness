import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Browser end-to-end tests for the local Web UI.
//   pnpm test:e2e            (Chrome + WebKit)
// WebKit is downloaded into .runtime/playwright (git-ignored) by `pnpm e2e:install`;
// Chrome uses the installed Google Chrome, nothing is downloaded for it.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(import.meta.dirname, ".runtime", "playwright");

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: ".work/e2e-results",
  globalSetup: "./test/e2e/global-setup.ts",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [["list"]],
  use: {
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } } },
  ],
});
