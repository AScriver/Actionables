import { defineConfig, devices } from "@playwright/test";

const node = JSON.stringify(process.execPath);
const webPort = process.env.WEB_PORT ?? "4173";
const apiPort = process.env.API_PORT ?? "4174";
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  use: {
    baseURL,
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
    url: `${baseURL}/api/health`,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1",
    timeout: 120_000,
    env: {
      DATABASE_URL: "file:./data/actionables-e2e.db",
      API_PORT: apiPort,
      WEB_PORT: webPort,
    },
  },
});
