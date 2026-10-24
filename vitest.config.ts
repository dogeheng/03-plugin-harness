import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "plugins/*/test/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "apps/web/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    globalSetup: ["test/global-setup.ts"],
    env: {
      HARNESS_SECRETS_BACKEND: "memory",
      HARNESS_LOG_LEVEL: "warn",
    },
  },
});
