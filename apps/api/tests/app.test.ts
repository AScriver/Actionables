import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { claimAgentTask } from "../src/agent-tasks.js";
import { createPrismaClient, type AppPrismaClient } from "../src/database.js";
import { importReviewedSeed, readReviewedSeed } from "../src/import-seed.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const prismaCli = resolve(repoRoot, "node_modules/prisma/build/index.js");

let databasePath: string;
let prisma: AppPrismaClient | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let scope: { projectId: string; repositoryId: string; worktreeId: string };

beforeAll(async () => {
  const databaseName = `test-${randomUUID()}.db`;
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
  const document = await readReviewedSeed();
  const firstImport = await importReviewedSeed(prisma, document);
  expect(firstImport).toEqual({
    created: 32,
    updated: 0,
    unchanged: 0,
    total: 32,
  });

  const secondImport = await importReviewedSeed(prisma, document);
  expect(secondImport).toEqual({
    created: 0,
    updated: 0,
    unchanged: 32,
    total: 32,
  });

  app = buildApp({ prisma });
  const project = await prisma.project.findFirstOrThrow({
    include: {
      repositories: {
        include: { worktrees: true },
      },
    },
  });
  scope = {
    projectId: project.id,
    repositoryId: project.repositories[0]!.id,
    worktreeId: project.repositories[0]!.worktrees[0]!.id,
  };
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

describe("Actionables API", () => {
  const createBody = (title: string) => ({
    title,
    priority: "Unset",
    effort: "Unknown",
    evidenceState: "Unclassified",
    ...scope,
    finding: "",
    description: "",
    research: [],
    validation: [],
    tags: [],
    userSources: [],
  });

  it("reports database health and preserves a supplied correlation id", async () => {
    const response = await app!.inject({
      method: "GET",
      url: "/api/health",
      headers: { "x-correlation-id": "test-correlation-id" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe("test-correlation-id");
    expect(response.json()).toEqual({
      status: "ok",
      database: "ok",
      requestId: "test-correlation-id",
    });
  });

  it("lists all 32 findings and labels the 28 collapsed top-level rows", async () => {
    const response = await app!.inject({
      method: "GET",
      url: "/api/actionables",
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.counts).toEqual({ total: 32, topLevel: 28 });
    expect(payload.items).toHaveLength(32);
    expect(
      payload.items.every(
        (item: { status: string }) => item.status === "Inbox",
      ),
    ).toBe(true);
    expect(payload.items[0].statusProvenance).toMatchObject({
      kind: "neutral-import",
      suggestedStatus: "Ready",
    });
  });

  it("returns a real persisted detail record", async () => {
    const response = await app!.inject({
      method: "GET",
      url: "/api/actionables/1",
    });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(payload.item.title).toBe(
      "Protect generated and downloaded files from anonymous static access",
    );
    expect(payload.item.files).toContainEqual({
      path: "Projects/WWW/Startup.cs",
      lines: "168–174",
      symbol: "Configure",
    });
  });

  it("projects non-secret claim state and only releases an expired lease at the current version", async () => {
    const created = await app!.inject({
      method: "POST",
      url: "/api/actionables",
      payload: createBody("Claim controls fixture"),
    });
    const item = created.json().item;
    const claimed = await claimAgentTask(prisma!, item.id, {
      agentId: "agent:claim-controls",
      workItemId: item.id,
      version: item.version,
      leaseMinutes: 30,
    });

    const active = await app!.inject({
      method: "GET",
      url: `/api/actionables/${item.id}`,
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().item.agentClaim).toMatchObject({
      agentId: "agent:claim-controls",
      state: "active",
      isReleasable: false,
    });
    expect(active.body).not.toContain(claimed.claim.claimToken);

    const activeRelease = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/agent-claim/release-expired`,
      payload: { version: active.json().item.version },
    });
    expect(activeRelease.statusCode).toBe(409);
    expect(activeRelease.json()).toMatchObject({
      code: "CLAIM_ACTIVE",
      current: {
        agentClaim: { state: "active", isReleasable: false },
      },
    });

    await prisma!.agentTaskClaim.update({
      where: { actionableId: item.recordId },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
    });
    const expired = await app!.inject({
      method: "GET",
      url: `/api/actionables/${item.id}`,
    });
    expect(expired.json().item.agentClaim).toMatchObject({
      agentId: "agent:claim-controls",
      state: "expired",
      isReleasable: true,
    });

    await prisma!.actionable.update({
      where: { id: item.recordId },
      data: { version: { increment: 1 } },
    });
    const staleRelease = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/agent-claim/release-expired`,
      payload: { version: expired.json().item.version },
    });
    expect(staleRelease.statusCode).toBe(409);
    expect(staleRelease.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      current: {
        version: expired.json().item.version + 1,
        agentClaim: { state: "expired", isReleasable: true },
      },
    });

    const released = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/agent-claim/release-expired`,
      payload: { version: staleRelease.json().current.version },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().item.agentClaim).toBeNull();
    expect(
      released
        .json()
        .item.activity.map((event: { type: string }) => event.type),
    ).toContain("agent-claim-expired");

    const repeatedRelease = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/agent-claim/release-expired`,
      payload: { version: released.json().item.version },
    });
    expect(repeatedRelease.statusCode).toBe(409);
    expect(repeatedRelease.json()).toMatchObject({
      code: "CLAIM_NOT_FOUND",
      current: { agentClaim: null },
    });

    const missingRelease = await app!.inject({
      method: "POST",
      url: "/api/actionables/999999/agent-claim/release-expired",
      payload: { version: 1 },
    });
    expect(missingRelease.statusCode).toBe(404);
    expect(missingRelease.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns 404 for an unknown actionable", async () => {
    const response = await app!.inject({
      method: "GET",
      url: "/api/actionables/999",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("validates malformed identifiers and exposes scope options", async () => {
    const invalid = await app!.inject({
      method: "GET",
      url: "/api/actionables/not-an-id",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      code: "INVALID_ID",
      errors: { id: ["Actionable id must be a positive integer."] },
    });

    const scopes = await app!.inject({ method: "GET", url: "/api/scopes" });
    expect(scopes.statusCode).toBe(200);
    expect(
      scopes.json().projects[0].repositories[0].worktrees[0],
    ).toMatchObject({
      id: scope.worktreeId,
      name: "CurrentSprint",
    });
  });

  it("adds a tracked repository with a usable default worktree", async () => {
    const response = await app!.inject({
      method: "POST",
      url: "/api/repositories",
      payload: {
        projectId: scope.projectId,
        name: "Tracked API Repo",
        localPath: "C:/repos/TrackedApiRepo/",
      },
    });

    expect(response.statusCode).toBe(201);
    const payload = response.json();
    expect(payload).toMatchObject({
      projectId: scope.projectId,
      repositoryId: expect.any(String),
      worktreeId: expect.any(String),
    });
    const repository = payload.scopes.projects[0].repositories.find(
      (item: { id: string }) => item.id === payload.repositoryId,
    );
    expect(repository).toMatchObject({
      name: "Tracked API Repo",
      worktrees: [
        {
          id: payload.worktreeId,
          name: "Default",
        },
      ],
    });

    const saved = await prisma!.repository.findUniqueOrThrow({
      where: { id: payload.repositoryId },
      include: { worktrees: true },
    });
    expect(saved.localPath).toBe("C:\\repos\\TrackedApiRepo");
    expect(saved.worktrees[0]).toMatchObject({
      name: "Default",
      localPath: saved.localPath,
      projectId: scope.projectId,
    });
  });

  it("rejects invalid and duplicate repository paths with field errors", async () => {
    const invalid = await app!.inject({
      method: "POST",
      url: "/api/repositories",
      payload: {
        projectId: scope.projectId,
        name: "Relative repo",
        localPath: "repos/relative",
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      errors: { localPath: ["Enter an absolute Windows path."] },
    });

    const duplicate = await app!.inject({
      method: "POST",
      url: "/api/repositories",
      payload: {
        projectId: scope.projectId,
        name: "tracked api repo",
        localPath: "c:\\repos\\TrackedApiRepo\\",
      },
    });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json()).toMatchObject({
      code: "DUPLICATE_REPOSITORY",
      errors: {
        name: expect.any(Array),
        localPath: expect.any(Array),
      },
    });
  });

  it("creates a minimally valid manual actionable with neutral values and a stable location", async () => {
    const response = await app!.inject({
      method: "POST",
      url: "/api/actionables",
      payload: createBody("Capture a manual follow-up"),
    });

    expect(response.statusCode).toBe(201);
    const payload = response.json();
    expect(response.headers.location).toBe(`/actionables/${payload.item.id}`);
    expect(payload.item).toMatchObject({
      title: "Capture a manual follow-up",
      priority: "Unset",
      status: "Inbox",
      effort: "Unknown",
      version: 1,
      statusProvenance: { kind: "user-authored" },
      immutableSourceEvidence: { imported: false },
    });
    expect(payload.item.statusHistory[0]).toMatchObject({
      previousStatus: null,
      newStatus: "Inbox",
      origin: "manual-create",
    });

    const reread = await app!.inject({
      method: "GET",
      url: `/api/actionables/${payload.item.id}`,
    });
    expect(reread.statusCode).toBe(200);
    expect(reread.json().item.recordId).toBe(payload.item.recordId);
  });

  it("returns field-addressable errors without accepting server-managed fields", async () => {
    const invalid = await app!.inject({
      method: "POST",
      url: "/api/actionables",
      payload: {
        ...createBody(""),
        version: 99,
        rawFragmentJson: { overwritten: true },
      },
    });

    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      errors: {
        title: ["Enter a title."],
      },
    });
    expect(invalid.json().errors.request[0]).toContain("Unrecognized");
  });

  it("edits every T-002 field and records a status change in the same save", async () => {
    const created = await app!.inject({
      method: "POST",
      url: "/api/actionables",
      payload: createBody("Editable actionable"),
    });
    const item = created.json().item;

    const response = await app!.inject({
      method: "PATCH",
      url: `/api/actionables/${item.id}`,
      payload: {
        version: item.version,
        title: "Edited actionable",
        priority: "High",
        status: "Researching",
        effort: "M–L",
        evidenceState: "Investigation",
        ...scope,
        finding: "A user-authored finding.",
        description: "A bounded intended result.",
        research: ["Research note one", "Research note two"],
        validation: ["Run the focused check"],
        tags: ["api", "triage"],
        userSources: [
          {
            type: "File",
            locator: "apps/api/src/app.ts",
            label: "API boundary",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().item).toMatchObject({
      title: "Edited actionable",
      priority: "High",
      status: "Researching",
      effort: "M–L",
      evidenceState: "Investigation",
      finding: "A user-authored finding.",
      description: "A bounded intended result.",
      research: ["Research note one", "Research note two"],
      validation: ["Run the focused check"],
      tags: ["api", "triage"],
      version: 2,
      userSources: [{ locator: "apps/api/src/app.ts" }],
    });
    expect(response.json().item.statusHistory[0]).toMatchObject({
      previousStatus: "Inbox",
      newStatus: "Researching",
      origin: "user-edit",
    });
  });

  it("performs every approved triage transition and rejects unavailable transitions", async () => {
    const created = await app!.inject({
      method: "POST",
      url: "/api/actionables",
      payload: {
        ...createBody("Transition matrix"),
        finding: "The item has a finding.",
        description: "The item has a bounded result.",
        validation: ["Verify the result."],
      },
    });
    let item = created.json().item;
    const path = `/api/actionables/${item.id}/status-transitions`;

    const transition = async (status: string) => {
      const response = await app!.inject({
        method: "POST",
        url: path,
        payload: { version: item.version, status, origin: "user" },
      });
      expect(response.statusCode).toBe(200);
      item = response.json().item;
    };

    await transition("Researching");
    await transition("Ready");
    await transition("Inbox");
    await transition("Ready");
    await transition("Researching");
    await transition("Inbox");

    const sameStatus = await app!.inject({
      method: "POST",
      url: path,
      payload: { version: item.version, status: "Inbox", origin: "user" },
    });
    expect(sameStatus.statusCode).toBe(422);
    expect(sameStatus.json()).toMatchObject({
      code: "INVALID_STATUS_TRANSITION",
    });
    expect(item.statusHistory).toHaveLength(7);
  });

  it("requires finding, description, and validation before Ready", async () => {
    const created = await app!.inject({
      method: "POST",
      url: "/api/actionables",
      payload: createBody("Not ready yet"),
    });
    const item = created.json().item;

    const response = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/status-transitions`,
      payload: { version: item.version, status: "Ready", origin: "user" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "READY_REQUIREMENTS_NOT_MET",
      errors: {
        finding: expect.any(Array),
        description: expect.any(Array),
        validation: expect.any(Array),
        status: expect.any(Array),
      },
    });
  });

  it("returns the current server record on a stale-version conflict", async () => {
    const created = await app!.inject({
      method: "POST",
      url: "/api/actionables",
      payload: createBody("Conflict original"),
    });
    const snapshot = created.json().item;

    const firstSave = await app!.inject({
      method: "PATCH",
      url: `/api/actionables/${snapshot.id}`,
      payload: {
        ...createBody("Conflict saved first"),
        version: snapshot.version,
        status: snapshot.status,
      },
    });
    expect(firstSave.statusCode).toBe(200);

    const staleSave = await app!.inject({
      method: "PATCH",
      url: `/api/actionables/${snapshot.id}`,
      payload: {
        ...createBody("Conflict stale draft"),
        version: snapshot.version,
        status: snapshot.status,
      },
    });
    expect(staleSave.statusCode).toBe(409);
    expect(staleSave.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      current: {
        title: "Conflict saved first",
        version: snapshot.version + 1,
      },
    });
  });

  it("preserves immutable imported source evidence when user fields are edited", async () => {
    const before = await prisma!.actionable.findUniqueOrThrow({
      where: { sourceOrdinal: 1 },
      select: {
        rawFragmentJson: true,
        filesJson: true,
        importProvider: true,
        sourceContainerId: true,
        sourceThread: true,
        contentHash: true,
      },
    });
    const detail = (
      await app!.inject({ method: "GET", url: "/api/actionables/1" })
    ).json().item;

    const response = await app!.inject({
      method: "PATCH",
      url: "/api/actionables/1",
      payload: {
        version: detail.version,
        title: `${detail.title} edited`,
        priority: detail.priority,
        status: detail.status,
        effort: detail.effort,
        evidenceState: "Confirmed",
        projectId: detail.scope.projectId,
        repositoryId: detail.scope.repositoryId,
        worktreeId: detail.scope.worktreeId,
        finding: detail.finding,
        description: detail.description,
        research: detail.research,
        validation: detail.validation,
        tags: detail.tags,
        userSources: [
          { type: "URL", locator: "https://example.test/evidence" },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().item.immutableSourceEvidence).toMatchObject({
      imported: true,
      sourceThread: before.sourceThread,
    });

    const after = await prisma!.actionable.findUniqueOrThrow({
      where: { sourceOrdinal: 1 },
      select: {
        rawFragmentJson: true,
        filesJson: true,
        importProvider: true,
        sourceContainerId: true,
        sourceThread: true,
        contentHash: true,
      },
    });
    expect(after).toEqual(before);
  });

  it("preserves imported source evidence through dismissal and reopening", async () => {
    const select = {
      rawFragmentJson: true,
      filesJson: true,
      importProvider: true,
      sourceContainerId: true,
      sourceThread: true,
      contentHash: true,
    } as const;
    const before = await prisma!.actionable.findUniqueOrThrow({
      where: { sourceOrdinal: 2 },
      select,
    });
    let item = (
      await app!.inject({ method: "GET", url: "/api/actionables/2" })
    ).json().item;
    const dismissed = await app!.inject({
      method: "POST",
      url: "/api/actionables/2/status-transitions",
      payload: {
        version: item.version,
        status: "Dismissed",
        reason: "This imported outcome is no longer intended.",
        origin: "user",
      },
    });
    expect(dismissed.statusCode).toBe(200);
    item = dismissed.json().item;
    const reopened = await app!.inject({
      method: "POST",
      url: "/api/actionables/2/status-transitions",
      payload: {
        version: item.version,
        status: "Ready",
        reason: "New evidence makes the imported finding actionable again.",
        origin: "user",
      },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().item.status).toBe("Ready");

    const after = await prisma!.actionable.findUniqueOrThrow({
      where: { sourceOrdinal: 2 },
      select,
    });
    expect(after).toEqual(before);
  });
});
