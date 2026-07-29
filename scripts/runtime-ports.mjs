import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import {
  defaultApiPort,
  defaultWebPort,
  loopbackApiHost,
  resolveRuntimeConfig,
} from "@actionables/contracts";

const runtimePortStateVersion = 1;
const maximumPort = 65_535;

export const runtimePortStateEnvironmentVariable =
  "ACTIONABLES_RUNTIME_PORT_STATE_PATH";

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= maximumPort;
}

function validPair(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.version === runtimePortStateVersion &&
    validPort(value.webPort) &&
    validPort(value.apiPort) &&
    value.webPort !== value.apiPort
  );
}

export function resolveRuntimePortStatePath(environment = process.env) {
  const configuredPath =
    environment[runtimePortStateEnvironmentVariable]?.trim();
  return resolve(configuredPath || "data/runtime-ports.json");
}

export async function readPersistedRuntimePorts(
  statePath,
  { warn = console.warn } = {},
) {
  let contents;
  try {
    contents = await readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Unable to read saved loopback ports from ${statePath}.`, {
      cause: error,
    });
  }

  try {
    const value = JSON.parse(contents);
    if (validPair(value)) {
      return {
        webPort: value.webPort,
        apiPort: value.apiPort,
      };
    }
  } catch {
    // The warning below covers malformed JSON and invalid saved values alike.
  }

  warn(
    `Ignoring invalid saved loopback ports in ${statePath}; a valid selection will replace them.`,
  );
  return null;
}

export async function persistRuntimePorts(statePath, pair) {
  if (!validPair({ version: runtimePortStateVersion, ...pair })) {
    throw new Error("Cannot persist an invalid loopback port pair.");
  }

  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        version: runtimePortStateVersion,
        webPort: pair.webPort,
        apiPort: pair.apiPort,
      })}\n`,
      { encoding: "utf8", flush: true },
    );
    await rename(temporaryPath, statePath);
  } catch (error) {
    throw new Error(`Unable to save loopback ports to ${statePath}.`, {
      cause: error,
    });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function candidateKey(candidate) {
  return `${candidate.webPort}:${candidate.apiPort}`;
}

function candidateFrom(webPort, apiPort, source, seen) {
  if (!validPort(webPort) || !validPort(apiPort) || webPort === apiPort) {
    return null;
  }
  const candidate = { webPort, apiPort, source };
  const key = candidateKey(candidate);
  if (seen.has(key)) return null;
  seen.add(key);
  return candidate;
}

export function* runtimePortCandidates({
  explicitWebPort,
  explicitApiPort,
  persistedPorts,
  fallbackWebPort = defaultWebPort,
  fallbackApiPort = defaultApiPort,
}) {
  const webIsExplicit = explicitWebPort !== undefined;
  const apiIsExplicit = explicitApiPort !== undefined;
  const seen = new Set();

  if (webIsExplicit && apiIsExplicit) {
    const explicit = candidateFrom(
      explicitWebPort,
      explicitApiPort,
      "explicit",
      seen,
    );
    if (explicit) yield explicit;
    return;
  }

  if (persistedPorts) {
    const persisted = candidateFrom(
      explicitWebPort ?? persistedPorts.webPort,
      explicitApiPort ?? persistedPorts.apiPort,
      "saved",
      seen,
    );
    if (persisted) yield persisted;
  }

  const defaults = candidateFrom(
    explicitWebPort ?? fallbackWebPort,
    explicitApiPort ?? fallbackApiPort,
    webIsExplicit || apiIsExplicit ? "partial-default" : "default",
    seen,
  );
  if (defaults) yield defaults;

  for (let offset = 2; offset <= maximumPort; offset += 2) {
    const webPort = explicitWebPort ?? fallbackWebPort + offset;
    const apiPort = explicitApiPort ?? fallbackApiPort + offset;
    if (
      (!webIsExplicit && webPort > maximumPort) ||
      (!apiIsExplicit && apiPort > maximumPort)
    ) {
      return;
    }
    const fallback = candidateFrom(webPort, apiPort, "fallback", seen);
    if (fallback) yield fallback;
  }
}

function listen(port) {
  const server = createServer();
  server.unref();
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      host: loopbackApiHost,
      port,
      exclusive: true,
    });
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolvePromise();
    });
  });
}

async function reserveCandidate(candidate) {
  let web;
  try {
    web = await listen(candidate.webPort);
  } catch (error) {
    throw Object.assign(error, { portRole: "web" });
  }

  let api;
  try {
    api = await listen(candidate.apiPort);
  } catch (error) {
    try {
      await closeServer(web);
    } catch (cleanupError) {
      throw Object.assign(
        new AggregateError(
          [error, cleanupError],
          `Unable to release the web reservation after API port ${candidate.apiPort} failed.`,
        ),
        { portRole: "api" },
      );
    }
    throw Object.assign(error, { portRole: "api" });
  }

  let webReleased = false;
  let apiReleased = false;
  return {
    async releaseWeb() {
      if (webReleased) return;
      await closeServer(web);
      webReleased = true;
    },
    async releaseApi() {
      if (apiReleased) return;
      await closeServer(api);
      apiReleased = true;
    },
    async releaseAll() {
      const results = await Promise.allSettled([
        this.releaseApi(),
        this.releaseWeb(),
      ]);
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "Unable to release all startup port reservations.",
        );
      }
    },
  };
}

function unavailableMessage(role, port, explicit) {
  const variable = role === "web" ? "WEB_PORT" : "API_PORT";
  return explicit
    ? `${variable} ${port} is already in use on ${loopbackApiHost}; explicit ports are never replaced.`
    : `${role} port ${port} is already in use on ${loopbackApiHost}.`;
}

export async function selectRuntimePorts({
  webPort,
  apiPort,
  statePath = resolveRuntimePortStatePath(),
  fallbackWebPort = defaultWebPort,
  fallbackApiPort = defaultApiPort,
  warn = console.warn,
} = {}) {
  const parsed = resolveRuntimeConfig({ webPort, apiPort });
  const webIsExplicit = webPort !== undefined;
  const apiIsExplicit = apiPort !== undefined;
  const explicitWebPort = webIsExplicit ? parsed.webPort : undefined;
  const explicitApiPort = apiIsExplicit ? parsed.apiPort : undefined;

  if (webIsExplicit && apiIsExplicit && explicitWebPort === explicitApiPort) {
    throw new Error("WEB_PORT and API_PORT must use different ports.");
  }

  const persistedPorts = await readPersistedRuntimePorts(statePath, { warn });
  let savedUnavailable = false;
  let defaultsUnavailable = false;

  for (const candidate of runtimePortCandidates({
    explicitWebPort,
    explicitApiPort,
    persistedPorts,
    fallbackWebPort,
    fallbackApiPort,
  })) {
    try {
      const reservations = await reserveCandidate(candidate);
      if (savedUnavailable) {
        warn(
          "The saved loopback port pair is unavailable; selected a new pair.",
        );
      }
      if (defaultsUnavailable && candidate.source === "fallback") {
        warn(
          `Default loopback ports ${fallbackWebPort}/${fallbackApiPort} are unavailable; using ${candidate.webPort}/${candidate.apiPort}.`,
        );
      }
      return {
        source: candidate.source,
        pair: {
          webPort: candidate.webPort,
          apiPort: candidate.apiPort,
        },
        runtimeConfig: resolveRuntimeConfig({
          webPort: String(candidate.webPort),
          apiPort: String(candidate.apiPort),
        }),
        reservations,
      };
    } catch (error) {
      const role = error.portRole;
      const failedPort = role === "web" ? candidate.webPort : candidate.apiPort;
      const failedExplicit = role === "web" ? webIsExplicit : apiIsExplicit;
      if (error.code !== "EADDRINUSE") {
        throw new Error(
          `Unable to reserve ${role} port ${failedPort} on ${loopbackApiHost}.`,
          { cause: error },
        );
      }
      if (failedExplicit) {
        throw new Error(unavailableMessage(role, failedPort, true), {
          cause: error,
        });
      }
      if (candidate.source === "saved") savedUnavailable = true;
      if (
        candidate.source === "default" ||
        candidate.source === "partial-default"
      ) {
        defaultsUnavailable = true;
      }
    }
  }

  throw new Error(
    `No free loopback port pair is available from ${fallbackWebPort}/${fallbackApiPort} through ${maximumPort}.`,
  );
}

export async function selectAndPersistRuntimePorts(options = {}) {
  const {
    persist = persistRuntimePorts,
    environment,
    ...selectionOptions
  } = options;
  const statePath =
    selectionOptions.statePath ?? resolveRuntimePortStatePath(environment);
  const selection = await selectRuntimePorts({
    ...selectionOptions,
    statePath,
  });
  try {
    await persist(statePath, selection.pair);
    return { ...selection, statePath };
  } catch (error) {
    try {
      await selection.reservations.releaseAll();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Loopback port persistence failed and startup reservations could not be fully released.",
      );
    }
    throw error;
  }
}
