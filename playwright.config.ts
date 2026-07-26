import { defineConfig, devices } from "@playwright/test";

const node = JSON.stringify(process.execPath);

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
    command: `${node} scripts/start-e2e.mjs`,
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1",
    timeout: 120_000,
    env: {
      DATABASE_URL: "file:./data/actionables-e2e.db",
    },
  },
});
