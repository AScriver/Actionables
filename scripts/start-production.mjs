import { spawn } from "node:child_process";
import process from "node:process";
import { resolveRuntimeConfig } from "@actionables/contracts";

const runtimeConfig = resolveRuntimeConfig({
  webPort: process.env.WEB_PORT,
  apiPort: process.env.API_PORT,
});
const runtimeEnvironment = {
  ...process.env,
  WEB_PORT: String(runtimeConfig.webPort),
  API_PORT: String(runtimeConfig.apiPort),
};

const children = [
  spawn(process.execPath, ["apps/api/dist/server.js"], {
    stdio: "inherit",
    env: runtimeEnvironment,
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview"], {
    stdio: "inherit",
    env: runtimeEnvironment,
  }),
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
        `Production child exited unexpectedly (${signal ?? code ?? "unknown"}).`,
      );
      stop(code || 1);
    }
  });
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
