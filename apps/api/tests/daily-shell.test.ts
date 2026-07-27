import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrismaClient, type AppPrismaClient } from "../src/database.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const prismaCli = resolve(repoRoot, "node_modules/prisma/build/index.js");

let databasePath: string;
let prisma: AppPrismaClient;
let app: ReturnType<typeof buildApp>;
let scope: { projectId: string; repositoryId: string; worktreeId: string };

const json = (value: unknown) => value as never;

beforeAll(async () => {
  const databaseName = `daily-shell-${randomUUID()}.db`;
  databasePath = resolve(repoRoot, "data", databaseName);
  const databaseUrl = `file:./data/${databaseName}`;
  const databaseFile = await open(databasePath, "a");
  await databaseFile.close();
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
  prisma = createPrismaClient(databaseUrl);
  const project = await prisma.project.create({
    data: { externalKey: "daily-project", name: "Daily Project" },
  });
  const repository = await prisma.repository.create({
    data: {
      externalKey: "daily-repository",
      name: "Daily Repository",
      localPath: "C:/repos/daily",
      projectId: project.id,
    },
  });
  const worktree = await prisma.worktree.create({
    data: {
      externalKey: "daily-worktree",
      name: "Daily Worktree",
      localPath: "C:/repos/daily/worktree",
      projectId: project.id,
      repositoryId: repository.id,
    },
  });
  scope = {
    projectId: project.id,
    repositoryId: repository.id,
    worktreeId: worktree.id,
  };

  const statuses = [
    "Inbox",
    "Researching",
    "Ready",
    "In progress",
    "Blocked",
    "Ready",
    "Ready",
    "Done",
    "In progress",
    "Ready",
    "Ready",
  ];
  for (let index = 0; index < statuses.length; index += 1) {
    const ordinal = index + 1;
    const status = statuses[index]!;
    await prisma.actionable.create({
      data: {
        externalKey: `daily-${ordinal}`,
        sourceOrdinal: ordinal,
        title:
          ordinal === 3
            ? "Fix parser symbol Widget.Parse"
            : `Daily item ${ordinal}`,
        priority: ordinal === 3 ? "Critical" : ordinal % 2 ? "High" : "Medium",
        status,
        statusProvenance: "Deterministic daily-shell fixture.",
        effort: ordinal === 3 ? "M" : "S",
        evidenceState: ordinal === 3 ? "Confirmed" : "Investigation",
        updatedLabel: "fixture",
        manualBlockerMd:
          status === "Blocked" ? "Waiting on a manual decision." : null,
        finding:
          ordinal === 3
            ? "Parser fails in src/widget.ts"
            : `Finding ${ordinal}`,
        description: `Description ${ordinal}`,
        researchJson: json([`Research note ${ordinal}`]),
        validationJson: json([`Validate ${ordinal}`]),
        filesJson: json(
          ordinal === 3
            ? [
                {
                  path: "src/widget.ts",
                  symbol: "Widget.Parse",
                  lines: "10-20",
                },
              ]
            : [],
        ),
        tagsJson: json(ordinal === 3 ? ["parser", "backend"] : ["daily"]),
        userSourcesJson: json([]),
        blockedByOrdinalsJson: json([]),
        blocksOrdinalsJson: json([]),
        childOrdinalsJson: json([]),
        importProvider: "MANUAL",
        sourceContainerId: "",
        sourceThread: ordinal === 3 ? "codex://threads/parser-review" : "",
        contentHash: "",
        rawFragmentJson: json({ fixture: true }),
        ...scope,
        archivedAt: ordinal === 7 ? new Date("2026-07-24T12:00:00.000Z") : null,
        statusHistory: {
          create: {
            previousStatus: status === "In progress" ? "Ready" : null,
            newStatus: status,
            origin: "fixture",
            occurredAt: new Date(
              `2026-07-24T${String(ordinal).padStart(2, "0")}:00:00.000Z`,
            ),
          },
        },
        activityEvents:
          ordinal === 10
            ? {
                create: {
                  type: "reopened",
                  summary: "Reopened Done to Ready",
                  metadataJson: json({ reason: "Regression returned." }),
                },
              }
            : undefined,
      },
    });
  }
  const rows = await prisma.actionable.findMany({
    orderBy: { sourceOrdinal: "asc" },
  });
  const claimReferenceTime = Date.now();
  await prisma.agentTaskClaim.createMany({
    data: [
      {
        actionableId: rows[0]!.id,
        agentId: "agent:expiring",
        claimTokenHash: "expiring-claim-token-hash",
        claimedAt: new Date(claimReferenceTime - 25 * 60_000),
        renewedAt: new Date(claimReferenceTime - 25 * 60_000),
        leaseExpiresAt: new Date(claimReferenceTime + 5 * 60_000),
      },
      {
        actionableId: rows[1]!.id,
        agentId: "agent:abandoned",
        claimTokenHash: "abandoned-claim-token-hash",
        claimedAt: new Date(claimReferenceTime - 35 * 60_000),
        renewedAt: new Date(claimReferenceTime - 35 * 60_000),
        leaseExpiresAt: new Date(claimReferenceTime - 5 * 60_000),
      },
    ],
  });
  await prisma.hierarchyRelationship.create({
    data: { parentId: rows[2]!.id, childId: rows[10]!.id },
  });
  await prisma.dependencyRelationship.create({
    data: { dependentId: rows[5]!.id, prerequisiteId: rows[6]!.id },
  });
  await prisma.validationRecord.create({
    data: {
      actionableId: rows[8]!.id,
      type: "Automated test",
      outcome: "Passed",
      notesMd: "Passed after work started.",
      evidenceMd: "pnpm test",
      origin: "fixture",
      recordedAt: new Date("2026-07-25T00:00:00.000Z"),
    },
  });
  app = buildApp({ prisma });
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  if (databasePath) {
    await Promise.all(
      ["", "-journal", "-shm", "-wal"].map((suffix) =>
        rm(`${databasePath}${suffix}`, { force: true }),
      ),
    );
  }
});

describe("daily-use shell queries and archive policy", () => {
  it("derives every dashboard queue and links to an equivalent authoritative list", async () => {
    const response = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(response.statusCode).toBe(200);
    const dashboard = response.json();
    expect(dashboard.counts).toEqual({ total: 10, topLevel: 9, nested: 1 });
    expect(
      Object.fromEntries(
        dashboard.alerts.map((alert: { key: string; count: number }) => [
          alert.key,
          alert.count,
        ]),
      ),
    ).toEqual({
      "expiring-claims": 1,
      "blocked-work": 2,
      "missing-validation": 1,
      "abandoned-sessions": 1,
    });
    expect(
      dashboard.alerts.find(
        (alert: { key: string }) => alert.key === "expiring-claims",
      ),
    ).toMatchObject({
      tone: "warning",
      items: [
        {
          actionable: { id: 1 },
          detail: expect.stringContaining("agent:expiring"),
          dueAt: expect.any(String),
        },
      ],
    });
    expect(
      dashboard.alerts.find(
        (alert: { key: string }) => alert.key === "abandoned-sessions",
      ),
    ).toMatchObject({
      tone: "critical",
      items: [
        {
          actionable: { id: 2 },
          detail: expect.stringContaining("agent:abandoned"),
          dueAt: expect.any(String),
        },
      ],
    });
    expect(
      Object.fromEntries(
        dashboard.queues.map((queue: { key: string; count: number }) => [
          queue.key,
          queue.count,
        ]),
      ),
    ).toEqual({
      inbox: 1,
      researching: 1,
      ready: 3,
      "in-progress": 2,
      "manual-blocked": 1,
      "dependency-blocked": 1,
      "awaiting-validation": 1,
      "recently-updated": 10,
      "recently-completed": 1,
      reopened: 1,
    });

    for (const queue of dashboard.queues as Array<{
      count: number;
      query: Record<string, string>;
    }>) {
      const params = new URLSearchParams(queue.query);
      const list = await app.inject({
        method: "GET",
        url: `/api/actionables?${params}`,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().result.matched).toBe(queue.count);
    }
  });

  it("combines cross-scope discovery, searches technical references, and sorts stably", async () => {
    const params = new URLSearchParams({
      project: scope.projectId,
      repository: scope.repositoryId,
      worktree: scope.worktreeId,
      priority: "Critical",
      effort: "M",
      evidence: "Confirmed",
      tag: "parser",
      q: "widget.parse",
      sort: "title",
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/actionables?${params}`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().items.map((item: { id: number }) => item.id),
    ).toEqual([3]);

    const pathSearch = await app.inject({
      method: "GET",
      url: "/api/actionables?q=src%2Fwidget.ts",
    });
    expect(pathSearch.json().items[0].id).toBe(3);
  });

  it("safely removes malformed query values from normalized canonical state", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/actionables?priority=urgent&sort=random&archived=maybe&q=parser",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.normalizedQuery).toEqual({ q: "parser" });
  });

  it("archives and restores an actionable without changing workflow or relationships", async () => {
    const before = (
      await app.inject({ method: "GET", url: "/api/actionables/3" })
    ).json().item;
    const impact = await app.inject({
      method: "GET",
      url: "/api/archive-impact/actionable/3",
    });
    expect(impact.json()).toMatchObject({
      counts: { activeSubtasks: 1 },
      target: { name: "Fix parser symbol Widget.Parse" },
    });
    const archived = await app.inject({
      method: "POST",
      url: "/api/actionables/3/archive",
      payload: { version: before.version },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().item).toMatchObject({
      status: "Ready",
      archiveState: { directlyArchived: true, isArchived: true },
    });
    expect(archived.json().item.relationships.subtasks).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: "/api/actionables" }))
        .json()
        .items.some((item: { id: number }) => item.id === 3),
    ).toBe(false);
    const archivedList = await app.inject({
      method: "GET",
      url: "/api/actionables?archived=archived",
    });
    expect(
      archivedList.json().items.some((item: { id: number }) => item.id === 3),
    ).toBe(true);

    const staleRestore = await app.inject({
      method: "POST",
      url: "/api/actionables/3/restore",
      payload: { version: before.version },
    });
    expect(staleRestore.statusCode).toBe(409);
    expect(staleRestore.json().code).toBe("VERSION_CONFLICT");

    const restored = await app.inject({
      method: "POST",
      url: "/api/actionables/3/restore",
      payload: { version: archived.json().item.version },
    });
    expect(restored.json().item).toMatchObject({
      status: "Ready",
      archiveState: { directlyArchived: false, isArchived: false },
    });
    expect(
      restored
        .json()
        .item.activity.slice(-2)
        .map((event: { type: string }) => event.type),
    ).toEqual(["archived", "restored"]);
  });

  it("keeps archived unresolved prerequisites dependency-blocking", async () => {
    const dependent = (
      await app.inject({ method: "GET", url: "/api/actionables/6" })
    ).json().item;
    expect(dependent).toMatchObject({
      isDependencyBlocked: true,
      unresolvedDependencyCount: 1,
    });
    expect(dependent.relationships.blockedBy[0]).toMatchObject({
      state: "unresolved",
      prerequisite: {
        archiveState: { directlyArchived: true, isArchived: true },
      },
    });
  });

  it("uses inherited scope archival and preserves independently archived descendants", async () => {
    const itemSeven = (
      await app.inject({ method: "GET", url: "/api/actionables/7" })
    ).json().item;
    const scopesBefore = (
      await app.inject({ method: "GET", url: "/api/scopes" })
    ).json();
    const worktree = scopesBefore.projects[0].repositories[0].worktrees[0];
    const archivedScope = await app.inject({
      method: "POST",
      url: `/api/scopes/worktree/${worktree.id}/archive`,
      payload: { version: worktree.version },
    });
    expect(archivedScope.statusCode).toBe(200);
    const inherited = (
      await app.inject({ method: "GET", url: "/api/actionables/3" })
    ).json().item;
    expect(inherited.archiveState).toMatchObject({
      isArchived: true,
      directlyArchived: false,
      inheritedFrom: ["worktree"],
    });
    const forbiddenRestore = await app.inject({
      method: "POST",
      url: "/api/actionables/3/restore",
      payload: { version: inherited.version },
    });
    expect(forbiddenRestore.statusCode).toBe(422);
    expect(forbiddenRestore.json().code).toBe("ARCHIVED_ANCESTOR");

    const staleScope = await app.inject({
      method: "POST",
      url: `/api/scopes/worktree/${worktree.id}/restore`,
      payload: { version: worktree.version },
    });
    expect(staleScope.statusCode).toBe(409);

    const currentWorktree =
      archivedScope.json().projects[0].repositories[0].worktrees[0];
    const restoredScope = await app.inject({
      method: "POST",
      url: `/api/scopes/worktree/${worktree.id}/restore`,
      payload: { version: currentWorktree.version },
    });
    expect(restoredScope.statusCode).toBe(200);
    const stillDirect = (
      await app.inject({ method: "GET", url: "/api/actionables/7" })
    ).json().item;
    expect(stillDirect.archiveState).toMatchObject({
      isArchived: true,
      directlyArchived: true,
      inheritedFrom: [],
    });
    expect(stillDirect.status).toBe(itemSeven.status);
  });
});
