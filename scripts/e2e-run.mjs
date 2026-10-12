import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

function insideTemp(path) {
  const child = relative(realpathSync.native(tmpdir()), path);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new Error(
      "Browser tests require a dedicated path inside the user TEMP directory.",
    );
  }
  return path;
}

function port(value, fallback) {
  const text = value ?? fallback;
  if (
    !/^\d+$/.test(text) ||
    Number(text) < 1 ||
    Number(text) > 65535 ||
    [4173, 4174].includes(Number(text))
  ) {
    throw new Error(
      "Browser tests require dedicated WEB_PORT/API_PORT values, excluding 4173 and 4174.",
    );
  }
  return String(Number(text));
}

/** Resolve once, then pass these exact values to Playwright and its server. */
export function resolveE2ERun(environment = process.env) {
  const reuse = environment.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1";
  if (
    reuse &&
    ["DATABASE_URL", "WEB_PORT", "API_PORT", "ACTIONABLES_E2E_RUN_ID"].some(
      (key) => !environment[key],
    )
  ) {
    throw new Error(
      "Server reuse requires explicit DATABASE_URL, WEB_PORT, API_PORT and ACTIONABLES_E2E_RUN_ID from the intended test run.",
    );
  }
  const webPort = port(environment.WEB_PORT, "4973");
  const apiPort = port(environment.API_PORT, "4974");
  if (webPort === apiPort)
    throw new Error("Test web and API ports must differ.");
  const runId = environment.ACTIONABLES_E2E_RUN_ID ?? randomUUID();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      runId,
    )
  )
    throw new Error("Invalid test run ID.");
  const directory = insideTemp(
    realpathSync.native(
      environment.ACTIONABLES_E2E_RUN_DIRECTORY ??
        mkdtempSync(join(tmpdir(), "actionables-e2e-")),
    ),
  );
  const url =
    environment.DATABASE_URL ?? `file:${join(directory, "browser.db")}`;
  if (!url.startsWith("file:"))
    throw new Error("Test DATABASE_URL must be an absolute file: URL.");
  let databasePath = url.slice(5);
  if (databasePath.startsWith("//")) databasePath = fileURLToPath(url);
  if (!isAbsolute(databasePath) || /[?#]/.test(databasePath))
    throw new Error(
      "Test DATABASE_URL must name one absolute database file without query parameters.",
    );
  databasePath = insideTemp(
    resolve(realpathSync.native(dirname(databasePath)), basename(databasePath)),
  );
  if (
    basename(databasePath).toLowerCase() === "actionables.db" ||
    !databasePath.toLowerCase().endsWith(".db")
  )
    throw new Error("Use a dedicated .db test file, never actionables.db.");
  if (reuse) {
    databasePath = insideTemp(realpathSync.native(databasePath));
    const file = statSync(databasePath);
    if (
      !file.isFile() ||
      file.nlink !== 1 ||
      basename(databasePath).toLowerCase() === "actionables.db"
    )
      throw new Error("Reuse requires one isolated regular database file.");
  }
  const outputPath =
    environment.ACTIONABLES_E2E_OUTPUT_DIRECTORY ??
    mkdtempSync(join(directory, "results-"));
  let outputDirectory;
  // Playwright removes its empty output directory before starting the server.
  if (existsSync(outputPath)) outputDirectory = realpathSync.native(outputPath);
  else
    outputDirectory = resolve(
      realpathSync.native(dirname(outputPath)),
      basename(outputPath),
    );
  insideTemp(outputDirectory);
  if (
    dirname(outputDirectory) !== directory ||
    !/^results-[a-z0-9]+$/i.test(basename(outputDirectory)) ||
    relative(outputDirectory, databasePath).split(sep)[0] !== ".."
  ) {
    throw new Error(
      "Browser output must use its own results-* directory beside the database, never contain it.",
    );
  }
  return {
    reuse,
    directory,
    databasePath,
    outputDirectory,
    webPort,
    apiPort,
    runId,
    environment: {
      DATABASE_URL: `file:${databasePath.replace(/\\/g, "/")}`,
      WEB_PORT: webPort,
      API_PORT: apiPort,
      ACTIONABLES_E2E_RUN_ID: runId,
      ACTIONABLES_E2E_RUN_DIRECTORY: directory,
      ACTIONABLES_E2E_OUTPUT_DIRECTORY: outputDirectory,
      ACTIONABLES_AGENT_HOME: join(directory, "agent-home"),
      ACTIONABLES_RUNTIME_PORT_STATE_PATH: join(
        directory,
        "runtime-ports.json",
      ),
      ACTIONABLES_MCP_TOKEN: "",
      PLAYWRIGHT_HTML_OUTPUT_DIR: join(
        directory,
        `${basename(outputDirectory)}-html`,
      ),
    },
  };
}

/** Never reset an existing file, including abandoned SQLite sidecars. */
export function createFreshE2EDatabase(run) {
  if (run.reuse)
    throw new Error("A reused server must not run database setup.");
  if (
    ["", "-journal", "-shm", "-wal"].some((suffix) =>
      existsSync(run.databasePath + suffix),
    )
  )
    throw new Error(
      "The test database or a sidecar already exists. Choose a fresh path or explicitly reuse its server.",
    );
  closeSync(openSync(run.databasePath, "wx"));
}

export function databaseFingerprint(path) {
  let canonical = realpathSync.native(path).replace(/\\/g, "/");
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  return createHash("sha256").update(canonical).digest("hex");
}

export async function verifyE2EServer(run) {
  const expectedHash = databaseFingerprint(run.databasePath);
  for (const port of [run.apiPort, run.webPort]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const health = await response.json();
    if (
      !response.ok ||
      health.status !== "ok" ||
      health.database !== "ok" ||
      health.schema !== "current" ||
      health.testRun?.id !== run.runId ||
      health.testRun?.databaseHash !== expectedHash
    ) {
      throw new Error(
        `Test server identity mismatch on port ${port}; no browser tests were started.`,
      );
    }
  }
}
