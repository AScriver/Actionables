import { defineConfig, devices } from "@playwright/test";
import { resolveE2ERun } from "./scripts/e2e-run.mjs";

const node = JSON.stringify(process.execPath);
const run = resolveE2ERun();
Object.assign(process.env, run.environment);
const webPort = run.webPort;
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: run.outputDirectory,
  globalSetup: "./scripts/verify-e2e-server.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  use: {
    baseURL,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [
            {
              name: "actionables-agent-integration-setup-dismissed-v1",
              value: "dismissed",
            },
          ],
        },
      ],
    },
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
    reuseExistingServer: run.reuse,
    timeout: 120_000,
    env: run.environment,
  },
});
