import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  persistRuntimePorts,
  runtimePortCandidates,
  selectAndPersistRuntimePorts,
} from "../../../scripts/runtime-ports.mjs";

const resources = [];

function listen(port) {
  const server = createServer();
  server.unref();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      resolve(server),
    );
  });
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function trackedListener(port) {
  const server = await listen(port);
  resources.push(() => close(server));
  return server;
}

async function temporaryStatePath() {
  const directory = await mkdtemp(join(tmpdir(), "actionables-ports-"));
  resources.push(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "runtime-ports.json");
}

async function freeSequence(length = 4) {
  for (let first = 48_000; first <= 64_000 - length; first += length) {
    const servers = [];
    try {
      for (let offset = 0; offset < length; offset += 1) {
        servers.push(await listen(first + offset));
      }
      await Promise.all(servers.map(close));
      return Array.from({ length }, (_, offset) => first + offset);
    } catch {
      await Promise.all(servers.map(close));
    }
  }
  throw new Error("Unable to find free loopback ports for the test.");
}

async function select(options) {
  const selection = await selectAndPersistRuntimePorts({
    warn: vi.fn(),
    ...options,
  });
  resources.push(() => selection.reservations.releaseAll());
  return selection;
}

afterEach(async () => {
  await Promise.allSettled(resources.splice(0).map((dispose) => dispose()));
});

describe("runtime port candidates", () => {
  it("orders saved, default, and deterministic fallback pairs", () => {
    expect(
      Array.from(
        runtimePortCandidates({
          persistedPorts: { webPort: 5001, apiPort: 5002 },
          fallbackWebPort: 5101,
          fallbackApiPort: 5102,
        }),
      ).slice(0, 4),
    ).toEqual([
      { webPort: 5001, apiPort: 5002, source: "saved" },
      { webPort: 5101, apiPort: 5102, source: "default" },
      { webPort: 5103, apiPort: 5104, source: "fallback" },
      { webPort: 5105, apiPort: 5106, source: "fallback" },
    ]);
  });

  it("pins each explicit value and resolves only the omitted role", () => {
    expect(
      Array.from(
        runtimePortCandidates({
          explicitWebPort: 5200,
          persistedPorts: { webPort: 5001, apiPort: 5002 },
          fallbackWebPort: 5101,
          fallbackApiPort: 5102,
        }),
      ).slice(0, 3),
    ).toEqual([
      { webPort: 5200, apiPort: 5002, source: "saved" },
      { webPort: 5200, apiPort: 5102, source: "partial-default" },
      { webPort: 5200, apiPort: 5104, source: "fallback" },
    ]);

    expect(
      Array.from(
        runtimePortCandidates({
          explicitApiPort: 5200,
          persistedPorts: { webPort: 5001, apiPort: 5002 },
          fallbackWebPort: 5101,
          fallbackApiPort: 5102,
        }),
      ).slice(0, 3),
    ).toEqual([
      { webPort: 5001, apiPort: 5200, source: "saved" },
      { webPort: 5101, apiPort: 5200, source: "partial-default" },
      { webPort: 5103, apiPort: 5200, source: "fallback" },
    ]);
  });

  it("excludes same-port candidates and stops at the valid upper bound", () => {
    expect(
      Array.from(
        runtimePortCandidates({
          explicitWebPort: 5102,
          fallbackWebPort: 5101,
          fallbackApiPort: 5102,
        }),
      ).slice(0, 2),
    ).toEqual([
      { webPort: 5102, apiPort: 5104, source: "fallback" },
      { webPort: 5102, apiPort: 5106, source: "fallback" },
    ]);

    expect(
      Array.from(
        runtimePortCandidates({
          fallbackWebPort: 65_534,
          fallbackApiPort: 65_535,
        }),
      ),
    ).toEqual([{ webPort: 65_534, apiPort: 65_535, source: "default" }]);
  });
});

describe("runtime port selection and persistence", () => {
  it("selects and persists a free default pair, then reuses it", async () => {
    const [webPort, apiPort] = await freeSequence(2);
    const statePath = await temporaryStatePath();

    const initial = await select({
      statePath,
      fallbackWebPort: webPort,
      fallbackApiPort: apiPort,
    });
    expect(initial).toMatchObject({
      source: "default",
      previousPair: null,
      pair: { webPort, apiPort },
    });
    await initial.reservations.releaseAll();

    const restarted = await select({
      statePath,
      fallbackWebPort: webPort + 20,
      fallbackApiPort: apiPort + 20,
    });
    expect(restarted).toMatchObject({
      source: "saved",
      previousPair: { webPort, apiPort },
      pair: { webPort, apiPort },
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      version: 1,
      webPort,
      apiPort,
    });
  });

  it("falls back deterministically when either default is occupied", async () => {
    const [webPort, apiPort, fallbackWebPort, fallbackApiPort] =
      await freeSequence();
    const statePath = await temporaryStatePath();
    const occupyingListener = await trackedListener(apiPort);

    const selection = await select({
      statePath,
      fallbackWebPort: webPort,
      fallbackApiPort: apiPort,
    });

    expect(selection).toMatchObject({
      source: "fallback",
      pair: {
        webPort: fallbackWebPort,
        apiPort: fallbackApiPort,
      },
    });
    expect(occupyingListener.listening).toBe(true);

    const releasedDefaultWeb = await trackedListener(webPort);
    expect(releasedDefaultWeb.listening).toBe(true);
  });

  it("replaces an unavailable saved pair without altering its listener", async () => {
    const [savedWebPort, savedApiPort, webPort, apiPort] = await freeSequence();
    const statePath = await temporaryStatePath();
    await persistRuntimePorts(statePath, {
      webPort: savedWebPort,
      apiPort: savedApiPort,
    });
    const occupyingListener = await trackedListener(savedWebPort);

    const selection = await select({
      statePath,
      fallbackWebPort: webPort,
      fallbackApiPort: apiPort,
    });

    expect(selection).toMatchObject({
      source: "default",
      previousPair: {
        webPort: savedWebPort,
        apiPort: savedApiPort,
      },
      pair: { webPort, apiPort },
    });
    expect(occupyingListener.listening).toBe(true);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      webPort,
      apiPort,
    });
  });

  it("preserves partial explicit configuration in either direction", async () => {
    const [webPort, apiPort, explicitWebPort, explicitApiPort] =
      await freeSequence();
    const webStatePath = await temporaryStatePath();
    const explicitWeb = await select({
      statePath: webStatePath,
      webPort: String(explicitWebPort),
      fallbackWebPort: webPort,
      fallbackApiPort: apiPort,
    });
    expect(explicitWeb.pair).toEqual({
      webPort: explicitWebPort,
      apiPort,
    });
    await explicitWeb.reservations.releaseAll();

    const apiStatePath = await temporaryStatePath();
    const explicitApi = await select({
      statePath: apiStatePath,
      apiPort: String(explicitApiPort),
      fallbackWebPort: webPort,
      fallbackApiPort: apiPort,
    });
    expect(explicitApi.pair).toEqual({
      webPort,
      apiPort: explicitApiPort,
    });
  });

  it("fails clearly for occupied or duplicate explicit ports", async () => {
    const [webPort, apiPort] = await freeSequence(2);
    const statePath = await temporaryStatePath();
    const occupyingListener = await trackedListener(webPort);

    await expect(
      selectAndPersistRuntimePorts({
        statePath,
        webPort: String(webPort),
        apiPort: String(apiPort),
        warn: vi.fn(),
      }),
    ).rejects.toThrow(`WEB_PORT ${webPort} is already in use on 127.0.0.1`);
    expect(occupyingListener.listening).toBe(true);

    await expect(
      selectAndPersistRuntimePorts({
        statePath,
        webPort: String(apiPort),
        apiPort: String(apiPort),
        warn: vi.fn(),
      }),
    ).rejects.toThrow("WEB_PORT and API_PORT must use different ports.");
  });

  it("recovers from malformed saved state and replaces it", async () => {
    const [webPort, apiPort] = await freeSequence(2);
    const statePath = await temporaryStatePath();
    await writeFile(statePath, "{not-json", "utf8");
    const warn = vi.fn();

    const selection = await selectAndPersistRuntimePorts({
      statePath,
      fallbackWebPort: webPort,
      fallbackApiPort: apiPort,
      warn,
    });
    resources.push(() => selection.reservations.releaseAll());

    expect(selection.pair).toEqual({ webPort, apiPort });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring invalid saved loopback ports"),
    );
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      version: 1,
      webPort,
      apiPort,
    });
  });

  it("releases reservations when persistence fails", async () => {
    const [webPort, apiPort] = await freeSequence(2);
    const statePath = await temporaryStatePath();

    await expect(
      selectAndPersistRuntimePorts({
        statePath,
        fallbackWebPort: webPort,
        fallbackApiPort: apiPort,
        warn: vi.fn(),
        persist: async () => {
          throw new Error("Simulated persistence failure.");
        },
      }),
    ).rejects.toThrow("Simulated persistence failure.");

    expect((await trackedListener(webPort)).listening).toBe(true);
    expect((await trackedListener(apiPort)).listening).toBe(true);
  });
});
