import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { join } from "node:path";
import { resolveE2ERun, createFreshE2EDatabase } from "./e2e-run.mjs";

const run = resolveE2ERun();
Object.assign(process.env, run.environment);
if (run.reuse)
  throw new Error(
    "Use Playwright's explicit server reuse; do not launch setup against reused data.",
  );
const build = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "packages/contracts/tsconfig.json"],
  { stdio: "inherit", env: process.env },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const { selectAndPersistRuntimePorts } = await import("./runtime-ports.mjs");
const selection = await selectAndPersistRuntimePorts({
  webPort: run.webPort,
  apiPort: run.apiPort,
  environment: process.env,
});

const setupCommands = [
  ["node_modules/prisma/build/index.js", "generate"],
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  ["node_modules/tsx/dist/cli.mjs", "apps/api/src/seed.ts"],
];

try {
  createFreshE2EDatabase(run);
  for (const args of setupCommands) {
    const result = spawnSync(process.execPath, args, {
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0)
      throw new Error(`Test setup failed: ${args[0]} (exit ${result.status}).`);
  }
  await writeFile(
    join(run.directory, "run.json"),
    JSON.stringify(
      {
        DATABASE_URL: run.environment.DATABASE_URL,
        WEB_PORT: run.webPort,
        API_PORT: run.apiPort,
        ACTIONABLES_E2E_RUN_ID: run.runId,
      },
      null,
      2,
    ),
  );
  console.log(`Isolated browser run: ${join(run.directory, "run.json")}`);
} finally {
  await selection.reservations.releaseAll();
}

// The launcher imports contracts, so load it after setup builds that package.
const { superviseChildren } = await import("./start-actionables.mjs");
superviseChildren([
  {
    label: "API",
    args: ["node_modules/tsx/dist/cli.mjs", "apps/api/src/server.ts"],
  },
  {
    label: "Web",
    args: [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      run.webPort,
      "--strictPort",
    ],
  },
]);
