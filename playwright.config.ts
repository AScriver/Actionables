import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PLAYWRIGHT_CHANNEL
          ? {
              channel: process.env.PLAYWRIGHT_CHANNEL as "chrome" | "msedge",
            }
          : {}),
      },
    },
  ],
  webServer: {
    command: "pnpm exec tsx scripts/reset-e2e-database.ts && pnpm run dev",
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: "file:./data/actionables-e2e.db",
    },
  },
});
