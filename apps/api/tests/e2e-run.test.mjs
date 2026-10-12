import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  createFreshE2EDatabase,
  databaseFingerprint,
  resolveE2ERun,
  verifyE2EServer,
} from "../../../scripts/e2e-run.mjs";

it("gives each fresh run unique TEMP data, profile, outputs and explicit ports", async () => {
  const first = resolveE2ERun({});
  const second = resolveE2ERun({});
  expect(first.databasePath).not.toBe(second.databasePath);
  expect(first.outputDirectory).not.toBe(second.outputDirectory);
  expect(first.runId).not.toBe(second.runId);
  expect(first.directory).toBe(await realpath(first.directory));
  expect(first.environment).toMatchObject({
    DATABASE_URL: expect.stringMatching(/^file:/),
    WEB_PORT: "4973",
    API_PORT: "4974",
    ACTIONABLES_MCP_TOKEN: "",
    ACTIONABLES_AGENT_HOME: join(first.directory, "agent-home"),
    ACTIONABLES_RUNTIME_PORT_STATE_PATH: join(
      first.directory,
      "runtime-ports.json",
    ),
  });
  expect(resolveE2ERun(first.environment)).toMatchObject(first);
  const removedOutput = join(first.directory, "results-absent");
  expect(
    resolveE2ERun({
      ...first.environment,
      ACTIONABLES_E2E_OUTPUT_DIRECTORY: removedOutput,
    }).outputDirectory,
  ).toBe(removedOutput);
});

it("rejects production, relative, non-TEMP, ambiguous and unsafe output targets", () => {
  const run = resolveE2ERun({});
  for (const overrides of [
    { DATABASE_URL: "file:./data/test.db" },
    { DATABASE_URL: `file:${join(process.cwd(), "data", "browser.db")}` },
    { DATABASE_URL: `file:${join(run.directory, "actionables.db")}` },
    { DATABASE_URL: `file:${run.databasePath}?mode=rw` },
    { DATABASE_URL: "https://example.com/browser.db" },
    { WEB_PORT: "4173" },
    { API_PORT: "4174" },
    { WEB_PORT: "0" },
    { API_PORT: "1e4" },
    { WEB_PORT: "4974" },
    { ACTIONABLES_E2E_OUTPUT_DIRECTORY: run.directory },
    { DATABASE_URL: `file:${join(run.outputDirectory, "browser.db")}` },
  ])
    expect(() => resolveE2ERun({ ...run.environment, ...overrides })).toThrow();
});

it("never resets an existing database or orphaned SQLite sidecar", () => {
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    const run = resolveE2ERun({});
    writeFileSync(run.databasePath + suffix, "keep existing data");
    expect(() => createFreshE2EDatabase(run)).toThrow(/already exists/);
    expect(readFileSync(run.databasePath + suffix, "utf8")).toBe(
      "keep existing data",
    );
    if (suffix) expect(existsSync(run.databasePath)).toBe(false);
  }
  const run = resolveE2ERun({});
  createFreshE2EDatabase(run);
  expect(existsSync(run.databasePath)).toBe(true);
  expect(() => createFreshE2EDatabase(run)).toThrow(/already exists/);
});

it("requires every reuse identifier and rejects aliases to shared data", () => {
  const run = resolveE2ERun({});
  createFreshE2EDatabase(run);
  const environment = {
    ...run.environment,
    PLAYWRIGHT_REUSE_EXISTING_SERVER: "1",
  };
  for (const key of [
    "DATABASE_URL",
    "WEB_PORT",
    "API_PORT",
    "ACTIONABLES_E2E_RUN_ID",
  ]) {
    const incomplete = { ...environment };
    delete incomplete[key];
    expect(() => resolveE2ERun(incomplete)).toThrow(/requires explicit/);
  }
  const reused = resolveE2ERun(environment);
  expect(reused.reuse).toBe(true);
  expect(() => createFreshE2EDatabase(reused)).toThrow(
    /must not run database setup/,
  );
  linkSync(run.databasePath, join(run.directory, "shared.db"));
  expect(() => resolveE2ERun(environment)).toThrow(/isolated regular/);
  const directory = join(run.directory, "directory.db");
  mkdirSync(directory);
  expect(() =>
    resolveE2ERun({ ...environment, DATABASE_URL: `file:${directory}` }),
  ).toThrow(/regular/);
});

async function listen(health) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(health()));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
}

it("checks both API and web health against the run ID and actual database", async () => {
  const run = resolveE2ERun({});
  createFreshE2EDatabase(run);
  const healthy = {
    status: "ok",
    database: "ok",
    schema: "current",
    testRun: {
      id: run.runId,
      databaseHash: databaseFingerprint(run.databasePath),
    },
  };
  let apiHealth = healthy;
  let webHealth = healthy;
  const api = await listen(() => apiHealth);
  const web = await listen(() => webHealth);
  const target = {
    ...run,
    apiPort: String(api.address().port),
    webPort: String(web.address().port),
  };
  try {
    await expect(verifyE2EServer(target)).resolves.toBeUndefined();
    for (const bad of [
      { ...healthy, testRun: undefined },
      { ...healthy, testRun: { ...healthy.testRun, id: randomUUID() } },
      {
        ...healthy,
        testRun: { ...healthy.testRun, databaseHash: "a".repeat(64) },
      },
      { ...healthy, schema: "outdated" },
    ]) {
      apiHealth = bad;
      await expect(verifyE2EServer(target)).rejects.toThrow(
        /identity mismatch/,
      );
      apiHealth = healthy;
      webHealth = bad;
      await expect(verifyE2EServer(target)).rejects.toThrow(
        /identity mismatch/,
      );
      webHealth = healthy;
    }
  } finally {
    await Promise.all([close(api), close(web)]);
  }
});

it("stops a launcher on occupied ports before database setup", async () => {
  const occupied = await listen(() => ({}));
  const other = await listen(() => ({}));
  const run = resolveE2ERun({
    WEB_PORT: String(occupied.address().port),
    API_PORT: String(other.address().port),
  });
  try {
    await expect(
      promisify(execFile)(process.execPath, ["scripts/start-e2e.mjs"], {
        env: {
          ...process.env,
          ...run.environment,
          PLAYWRIGHT_REUSE_EXISTING_SERVER: "0",
        },
        timeout: 25_000,
      }),
    ).rejects.toThrow(/explicit|unavailable|occupied/i);
    expect(existsSync(run.databasePath)).toBe(false);
  } finally {
    await Promise.all([close(occupied), close(other)]);
  }
}, 30_000);
