import { spawn, spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import process from "node:process";

const databasePath = "data/actionables-e2e.db";
for (const suffix of ["", "-journal", "-shm", "-wal"]) {
  await rm(`${databasePath}${suffix}`, { force: true });
}

const setupCommands = [
  ["node_modules/typescript/bin/tsc", "-p", "packages/contracts/tsconfig.json"],
  ["node_modules/prisma/build/index.js", "generate"],
  ["node_modules/tsx/dist/cli.mjs", "scripts/ensure-database-file.ts"],
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  ["node_modules/tsx/dist/cli.mjs", "apps/api/src/seed.ts"],
];

for (const args of setupCommands) {
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const children = [
  spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "apps/api/src/server.ts"],
    { stdio: "inherit", env: process.env },
  ),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4173"],
    { stdio: "inherit", env: process.env },
  ),
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  Promise.all(
    children.map((child) =>
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once("exit", resolve)),
    ),
  ).finally(() => {
    process.exitCode = exitCode;
  });
}

for (const child of children) {
  child.once("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(
        `E2E child exited unexpectedly (${signal ?? code ?? "unknown"}).`,
      );
      stop(code || 1);
    }
  });
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
