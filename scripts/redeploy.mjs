import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const localAppsSource = "C:\\Code\\LocalApps\\scripts";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const saveJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const databaseUrl = (path) => `file:${path.replaceAll("\\", "/")}`;

async function request(url, options = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
    ...options,
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

function run(command, args, cwd, environment = process.env) {
  execFileSync(command, args, {
    cwd,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
}

function powershell(script, cwd, environment) {
  run(
    "pwsh.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", ...script],
    cwd,
    environment,
  );
}

function requireInstallation(definition, releases) {
  if (
    definition?.id !== "actionables" ||
    definition.openOnly ||
    definition.dashboardUrl !== "http://127.0.0.1:4173/" ||
    definition.healthUrl !== "http://127.0.0.1:4174/api/health" ||
    !resolve(definition.workingDirectory).startsWith(`${resolve(releases)}\\`)
  ) {
    throw new Error(
      "The Actionables registration is not the expected Local Apps installation.",
    );
  }
}

async function verifyRelease(manager, definition, commit) {
  const deadline = Date.now() + 60_000;
  let failure;
  do {
    try {
      const probe = (url) =>
        request(url, { signal: AbortSignal.timeout(3_000) });
      const state = await probe(new URL("api/state", manager));
      const app = state.apps.find(
        (item) => item.definition.id === "actionables",
      );
      const health = await probe(definition.healthUrl);
      const proxy = await probe(new URL("api/health", definition.dashboardUrl));
      const settings = await probe(
        new URL("api/settings/agent-integration", definition.dashboardUrl),
      );
      const build = settings.mcp.runtime?.build;
      if (
        app?.status !== "running" ||
        !app.processId ||
        app.definition.workingDirectory !== definition.workingDirectory ||
        health.status !== "ok" ||
        health.database !== "ok" ||
        health.schema !== "current" ||
        proxy.status !== "ok" ||
        proxy.database !== "ok" ||
        proxy.schema !== "current" ||
        build?.sourceCommit !== commit ||
        build.releaseId !== basename(definition.workingDirectory)
      ) {
        throw new Error(
          "The managed process, database health or served build does not match the new release.",
        );
      }
      return {
        processId: app.processId,
        health,
        runtime: settings.mcp.runtime,
      };
    } catch (error) {
      failure = error;
    }
    await delay(1_000);
  } while (Date.now() < deadline);
  throw failure;
}

export async function redeploy({ checkOnly = false } = {}) {
  // shortcut: the existing packager fixes source/ports/database; extend that owner before supporting other installations.
  if (
    process.platform !== "win32" ||
    resolve(repository).toLowerCase() !== "c:\\code\\actionables"
  ) {
    throw new Error(
      "Run this from the C:\\Code\\Actionables checkout on Windows; that is the Local Apps packager's source.",
    );
  }
  const git = (...args) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
    }).trim();
  if (git("status", "--porcelain"))
    throw new Error(
      "Commit or stash all changes before redeploying; Local Apps packages HEAD.",
    );
  const commit = git("rev-parse", "HEAD");
  const installation = join(process.env.USERPROFILE, "Apps", "LocalApps");
  const appRoot = join(installation, "apps", "actionables");
  const releases = join(appRoot, "releases");
  const manifestPath = join(appRoot, "localapp.json");
  const database = join(repository, "data", "actionables.db");
  const packager = join(localAppsSource, "package-app.ps1");
  const backupScript = join(localAppsSource, "backup-sqlite.py");
  for (const path of [packager, backupScript, database, manifestPath]) {
    if (!existsSync(path))
      throw new Error(`Required deployment file is missing: ${path}`);
  }
  const manager = new URL(
    readJson(join(installation, "data", "address.json")).address,
  );
  if (
    manager.protocol !== "http:" ||
    manager.hostname !== "127.0.0.1" ||
    manager.username ||
    manager.password
  ) {
    throw new Error("Local Apps must use its loopback HTTP address.");
  }
  const session = await request(new URL("api/session", manager));
  if (session.application !== "Local Apps" || !session.token)
    throw new Error("Unexpected Local Apps session response.");
  const state = await request(new URL("api/state", manager));
  if (resolve(state.dataDirectory) !== resolve(installation, "data"))
    throw new Error("The manager owns a different installation.");
  const previous = state.apps.find(
    (item) => item.definition.id === "actionables",
  )?.definition;
  requireInstallation(previous, releases);
  const previousRelease = readJson(
    join(previous.workingDirectory, "release.json"),
  );
  if (resolve(previousRelease.database) !== resolve(database))
    throw new Error(
      "The installed database differs from the packager's database.",
    );
  console.log(
    `Source: ${repository}\nCommit: ${commit}\nDatabase: ${database}\nManager: ${manager}`,
  );
  if (checkOnly) {
    console.log("Preflight passed. No build, migration or restart performed.");
    return;
  }

  const lockPath = join(appRoot, "redeploy.lock");
  const lock = openSync(lockPath, "wx");
  const backup = join(
    installation,
    "backups",
    `actionables-redeploy-${Date.now()}`,
  );
  const mutate = (action, method = "POST", body = {}) =>
    request(new URL(`api/apps/actionables${action}`, manager), {
      signal: AbortSignal.timeout((previous.stopTimeoutSeconds + 15) * 1000),
      method,
      headers: {
        "X-Local-Apps-Token": session.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  let stopping = false;
  try {
    mkdirSync(backup);
    saveJson(join(backup, "previous-registration.json"), previous);
    writeFileSync(
      join(backup, "previous-localapp.json"),
      readFileSync(manifestPath),
    );
    console.log(
      "Building an independent release while the installed app stays available.",
    );
    const scratch = mkdtempSync(join(tmpdir(), "actionables-redeploy-"));
    powershell(["-File", packager, "-App", "actionables"], repository, {
      ...process.env,
      DATABASE_URL: databaseUrl(join(scratch, "build-only.db")),
    });
    const prepared = readJson(manifestPath);
    requireInstallation(prepared, releases);
    const release = readJson(join(prepared.workingDirectory, "release.json"));
    if (
      release.commit !== commit ||
      resolve(release.source) !== resolve(repository) ||
      resolve(release.database) !== resolve(database)
    ) {
      throw new Error(
        "The packaged source commit or database does not match this deployment.",
      );
    }
    const next = {
      ...previous,
      executable: prepared.executable,
      arguments: prepared.arguments,
      workingDirectory: prepared.workingDirectory,
    };
    const latest = await request(new URL("api/state", manager));
    const current = latest.apps.find(
      (item) => item.definition.id === "actionables",
    )?.definition;
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      throw new Error(
        "Actionables launch settings changed during the build; retry with the current settings.",
      );
    }
    powershell(
      [
        "-Command",
        "if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('ACTIONABLES_MCP_TOKEN', 'User'))) { throw 'Restore the Actionables user token before redeploying.' }",
      ],
      repository,
    );
    // Prove backup tooling works before taking down the running app.
    run(
      "python",
      [backupScript, database, join(backup, "before-stop.db")],
      repository,
    );
    stopping = true;
    await mutate("/stop");
    run(
      "python",
      [backupScript, database, join(backup, "before-migration.db")],
      repository,
    );
    powershell(
      ["-Command", "& corepack pnpm run db:migrate; exit $LASTEXITCODE"],
      next.workingDirectory,
      { ...process.env, DATABASE_URL: databaseUrl(database) },
    );
    await mutate("", "PUT", next);
    saveJson(manifestPath, next);
    await mutate("/start");
    const verification = await verifyRelease(manager, next, commit);
    saveJson(join(backup, "release-verification.json"), {
      completedAt: new Date().toISOString(),
      commit,
      release: next.workingDirectory,
      database,
      backup,
      ...verification,
    });
    console.log(
      `Deployed ${commit}\nRelease: ${next.workingDirectory}\nBackup and verification: ${backup}\n${next.dashboardUrl}`,
    );
  } catch (error) {
    if (stopping) {
      try {
        await mutate("/stop");
      } catch (stopError) {
        console.error(
          `Could not confirm the app stopped: ${stopError.message}`,
        );
      }
      console.error(
        `Deployment failed after stopping Actionables. Inspect Local Apps logs and ${backup}. No database or release rollback was attempted.`,
      );
    } else {
      console.error(
        `Deployment failed before stopping Actionables. Recovery files: ${backup}`,
      );
    }
    throw error;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== "--check"))
      throw new Error("Usage: node scripts/redeploy.mjs [--check]");
    await redeploy({ checkOnly: process.argv.includes("--check") });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
