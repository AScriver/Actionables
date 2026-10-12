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
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redeploy } from "../../../scripts/redeploy.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({
  closeSync: vi.fn(),
  existsSync: vi.fn(),
  mkdtempSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));

describe.skipIf(
  process.platform !== "win32" ||
    resolve(".").toLowerCase() !== "c:\\code\\actionables",
)("Local Apps redeploy", () => {
  const installation = join(process.env.USERPROFILE, "Apps", "LocalApps");
  const appRoot = join(installation, "apps", "actionables");
  const oldDirectory = join(appRoot, "releases", "old");
  const newDirectory = join(appRoot, "releases", "new");
  const database = "C:\\Code\\Actionables\\data\\actionables.db";
  const commit = "a".repeat(40);
  let files, definition, original, events, fail, dirty, wrongBuild, now;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv(
      "DATABASE_URL",
      "file:C:/Users/test/AppData/Local/Temp/actionables-redeploy-test/unused.db",
    );
    original = {
      id: "actionables",
      name: "My Actionables",
      openOnly: false,
      workingDirectory: oldDirectory,
      executable: "pwsh.exe",
      arguments: ["old"],
      dashboardUrl: "http://127.0.0.1:4173/",
      healthUrl: "http://127.0.0.1:4174/api/health",
      autoStart: false,
      autoRestart: false,
      stopTimeoutSeconds: 42,
    };
    definition = structuredClone(original);
    files = new Map([
      [
        join(installation, "data", "address.json"),
        JSON.stringify({ address: "http://127.0.0.1:9876/" }),
      ],
      [join(appRoot, "localapp.json"), JSON.stringify(original)],
      [join(oldDirectory, "release.json"), JSON.stringify({ database })],
    ]);
    events = [];
    fail = dirty = wrongBuild = false;
    now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    delay.mockImplementation(async () => {
      now += 1000;
    });
    existsSync.mockReturnValue(true);
    mkdtempSync.mockReturnValue(
      "C:\\Users\\test\\AppData\\Local\\Temp\\actionables-redeploy-test",
    );
    openSync.mockReturnValue(1);
    readFileSync.mockImplementation((path) => {
      if (!files.has(path)) throw new Error(`Unexpected file read: ${path}`);
      return files.get(path);
    });
    writeFileSync.mockImplementation((path, data) => files.set(path, data));
    execFileSync.mockImplementation((command, args, options) => {
      if (command === "git") {
        if (args.includes("status")) return dirty ? " M changed.txt" : "";
        return commit;
      }
      if (args.includes("-File")) {
        events.push("build");
        if (fail === "build") throw new Error("Build failed");
        files.set(
          join(appRoot, "localapp.json"),
          JSON.stringify({
            ...original,
            workingDirectory: newDirectory,
            arguments: ["new"],
            autoStart: true,
            autoRestart: true,
          }),
        );
        files.set(
          join(newDirectory, "release.json"),
          JSON.stringify({
            commit: wrongBuild ? "b".repeat(40) : commit,
            source: "C:\\Code\\Actionables",
            database,
          }),
        );
        if (fail === "concurrent-edit") definition.autoStart = true;
      } else if (command === "python") {
        const phase = args[2].endsWith("before-stop.db")
          ? "initial-backup"
          : "final-backup";
        events.push(phase);
        if (fail === phase) throw new Error("Backup failed");
      } else if (args.at(-1).includes("db:migrate")) {
        events.push("migrate");
        expect(options.cwd).toBe(newDirectory);
        expect(options.env.DATABASE_URL).toBe(
          "file:C:/Code/Actionables/data/actionables.db",
        );
        if (fail === "migrate") throw new Error("Migration failed");
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, options) => {
        const path = new URL(url).pathname;
        let value;
        let status = 200;
        if (path === "/api/session")
          value = { application: "Local Apps", token: "test-token" };
        else if (path === "/api/state")
          value = {
            dataDirectory: join(installation, "data"),
            apps: [
              {
                definition: structuredClone(definition),
                status: "running",
                processId: 123,
              },
            ],
          };
        else if (path.startsWith("/api/apps/actionables")) {
          expect(new URL(url).port).toBe("9876");
          expect(options.headers["X-Local-Apps-Token"]).toBe("test-token");
          events.push(
            options.method === "PUT" ? "switch" : path.split("/").at(-1),
          );
          if (options.method === "PUT") definition = JSON.parse(options.body);
          status = 204;
        } else if (path === "/api/health")
          value = { status: "ok", database: "ok", schema: "current" };
        else if (path === "/api/settings/agent-integration")
          value = {
            mcp: {
              runtime: {
                build: {
                  sourceCommit: fail === "identity" ? "old" : commit,
                  releaseId: "new",
                },
              },
            },
          };
        else throw new Error(`Unexpected request: ${url}`);
        return { ok: true, status, json: async () => value };
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("checks without building, locking, writing or stopping anything", async () => {
    await redeploy({ checkOnly: true });
    expect(events).toEqual([]);
    expect(openSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("builds first, backs up before migrating, preserves preferences and verifies the served commit", async () => {
    await redeploy();
    expect(events).toEqual([
      "build",
      "initial-backup",
      "stop",
      "final-backup",
      "migrate",
      "switch",
      "start",
    ]);
    expect(definition).toEqual({
      ...original,
      workingDirectory: newDirectory,
      arguments: ["new"],
    });
    const build = execFileSync.mock.calls.find(([, args]) =>
      args.includes("-File"),
    );
    expect(build[2].env.DATABASE_URL).toContain("build-only.db");
    const evidence = [...files.entries()].find(([path]) =>
      path.endsWith("release-verification.json"),
    );
    expect(JSON.parse(evidence[1])).toMatchObject({
      commit,
      release: newDirectory,
      database,
      processId: 123,
    });
    expect(closeSync).toHaveBeenCalledWith(1);
    expect(unlinkSync).toHaveBeenCalledWith(join(appRoot, "redeploy.lock"));
  });

  it("refuses dirty source and a concurrent redeploy before any changes", async () => {
    dirty = true;
    await expect(redeploy()).rejects.toThrow("Commit or stash");
    expect(openSync).not.toHaveBeenCalled();
    dirty = false;
    openSync.mockImplementation(() => {
      throw new Error("EEXIST");
    });
    await expect(redeploy()).rejects.toThrow("EEXIST");
    expect(events).toEqual([]);
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it.each(["build", "initial-backup", "concurrent-edit"])(
    "leaves the running app alone after %s failure",
    async (phase) => {
      fail = phase;
      await expect(redeploy()).rejects.toThrow();
      expect(events).not.toContain("stop");
      expect(events).not.toContain("migrate");
      expect(unlinkSync).toHaveBeenCalled();
    },
  );

  it("refuses a packaged commit that differs from the requested checkout", async () => {
    wrongBuild = true;
    await expect(redeploy()).rejects.toThrow("packaged source commit");
    expect(events).toEqual(["build"]);
  });

  it.each(["final-backup", "migrate", "identity"])(
    "stops recovery after %s failure without restoring data or claiming success",
    async (phase) => {
      fail = phase;
      await expect(redeploy()).rejects.toThrow();
      expect(events.at(-1)).toBe("stop");
      if (phase !== "identity") expect(events).not.toContain("start");
      expect(
        [...files.keys()].some((path) =>
          path.endsWith("release-verification.json"),
        ),
      ).toBe(false);
      expect(
        execFileSync.mock.calls.filter(([command]) => command === "python"),
      ).toHaveLength(2);
      expect(unlinkSync).toHaveBeenCalled();
    },
  );

  it("rejects a different database before acquiring the deployment lock", async () => {
    files.set(
      join(oldDirectory, "release.json"),
      JSON.stringify({ database: "C:\\other.db" }),
    );
    await expect(redeploy()).rejects.toThrow("installed database differs");
    expect(events).toEqual([]);
    expect(openSync).not.toHaveBeenCalled();
  });
});
