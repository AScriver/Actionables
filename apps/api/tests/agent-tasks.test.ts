import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentTaskClaimError,
  claimAgentTask,
  dismissAgentTask,
  forceReleaseAgentTaskClaim,
  handoffClaimedAgentTask,
  listAgentTasks,
  recoverAgentTaskClaim,
  recordClaimedAgentTaskValidation,
  releaseAgentTaskClaim,
  renewAgentTaskClaim,
  transitionClaimedAgentTask,
  updateClaimedAgentTask,
} from "../src/agent-tasks.js";
import { createPrismaClient, type AppPrismaClient } from "../src/database.js";
import { exportPortableDocument } from "../src/portable-format.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const prismaCli = resolve(repoRoot, "node_modules/prisma/build/index.js");
const json = (value: unknown) => value as never;

let databasePath: string;
let databaseUrl: string;
let prisma: AppPrismaClient;
let scope: { projectId: string; repositoryId: string; worktreeId: string };
let nextOrdinal = 1;

async function createTask(
  overrides: {
    status?: string;
    archivedAt?: Date | null;
    title?: string;
    creatorThreadId?: string;
    finding?: string;
    description?: string;
    research?: string[];
    validation?: string[];
  } = {},
) {
  const ordinal = nextOrdinal++;
  return prisma.actionable.create({
    data: {
      externalKey: `agent-task-${ordinal}`,
      sourceOrdinal: ordinal,
      title: overrides.title ?? `Agent task ${ordinal}`,
      priority: "High",
      status: overrides.status ?? "Ready",
      statusProvenance: "Agent task test fixture.",
      effort: "S",
      evidenceState: "Confirmed",
      archivedAt: overrides.archivedAt ?? null,
      updatedLabel: "fixture",
      finding: overrides.finding ?? "",
      description: overrides.description ?? "",
      researchJson: json(overrides.research ?? []),
      validationJson: json(overrides.validation ?? []),
      filesJson: json([]),
      tagsJson: json([]),
      userSourcesJson: json([]),
      blockedByOrdinalsJson: json([]),
      blocksOrdinalsJson: json([]),
      childOrdinalsJson: json([]),
      importProvider: "MANUAL",
      sourceContainerId: "",
      sourceThread: "",
      contentHash: "",
      rawFragmentJson: json({
        fixture: true,
        ...(overrides.creatorThreadId
          ? { creatorThreadId: overrides.creatorThreadId }
          : {}),
      }),
      ...scope,
    },
  });
}

function expectClaimError(error: unknown, code: AgentTaskClaimError["code"]) {
  expect(error).toBeInstanceOf(AgentTaskClaimError);
  expect((error as AgentTaskClaimError).code).toBe(code);
}

beforeAll(async () => {
  const databaseName = `agent-tasks-${randomUUID()}.db`;
  databasePath = resolve(repoRoot, "data", databaseName);
  databaseUrl = `file:./data/${databaseName}`;
  const databaseFile = await open(databasePath, "a");
  await databaseFile.close();
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
  prisma = createPrismaClient(databaseUrl);
  const project = await prisma.project.create({
    data: { externalKey: "agent-project", name: "Agent Project" },
  });
  const repository = await prisma.repository.create({
    data: {
      externalKey: "agent-repository",
      name: "Agent Repository",
      projectId: project.id,
    },
  });
  const worktree = await prisma.worktree.create({
    data: {
      externalKey: "agent-worktree",
      name: "Agent Worktree",
      projectId: project.id,
      repositoryId: repository.id,
    },
  });
  scope = {
    projectId: project.id,
    repositoryId: repository.id,
    worktreeId: worktree.id,
  };
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (databasePath) {
    await Promise.all(
      ["", "-journal", "-shm", "-wal"].map((suffix) =>
        rm(`${databasePath}${suffix}`, { force: true }),
      ),
    );
  }
});

describe("agent task claims", () => {
  it("lists only active nonterminal tasks and filters available versus mine", async () => {
    const available = await createTask({ title: "Available" });
    const mine = await createTask({ title: "Mine" });
    await createTask({ status: "Done", title: "Done" });
    await createTask({
      archivedAt: new Date("2026-07-25T00:00:00.000Z"),
      title: "Archived",
    });
    const claimed = await claimAgentTask(prisma, mine.sourceOrdinal, {
      agentId: "agent:list",
      workItemId: mine.sourceOrdinal,
      version: mine.version,
      leaseMinutes: 30,
    });

    const availableList = await listAgentTasks(prisma, {
      agentId: "agent:list",
      view: "available",
      workItemId: available.sourceOrdinal,
      limit: 100,
    });
    expect(availableList.items.map((item) => item.id)).toContain(
      available.sourceOrdinal,
    );
    expect(availableList.items.map((item) => item.id)).not.toContain(
      mine.sourceOrdinal,
    );

    const mineList = await listAgentTasks(prisma, {
      agentId: "agent:list",
      view: "mine",
      limit: 100,
    });
    expect(mineList.items).toEqual([
      expect.objectContaining({
        id: mine.sourceOrdinal,
        claim: expect.objectContaining({ agentId: "agent:list" }),
      }),
    ]);
    expect(claimed.task.status).toBe("Ready");
  });

  it("requires a feature or bug root and keeps discovery and claims inside it", async () => {
    const root = await createTask({ title: "Feature root" });
    const child = await createTask({ title: "Feature task" });
    const manuallyBlocked = await createTask({
      status: "Blocked",
      title: "Manually blocked feature task",
    });
    const unrelated = await createTask({ title: "Other feature task" });
    await prisma.actionable.update({
      where: { id: child.id },
      data: {
        finding: "A focused finding for the feature task.",
        tagsJson: json(["feature", "agent"]),
      },
    });
    await prisma.hierarchyRelationship.create({
      data: {
        parentId: root.id,
        childId: child.id,
        provenance: "test",
      },
    });
    await prisma.hierarchyRelationship.create({
      data: {
        parentId: root.id,
        childId: manuallyBlocked.id,
        provenance: "test",
      },
    });
    await prisma.dependencyRelationship.create({
      data: {
        dependentId: child.id,
        prerequisiteId: unrelated.id,
        provenance: "test",
      },
    });
    await prisma.actionable.update({
      where: { id: child.id },
      data: { updatedAt: new Date("2030-01-01T00:00:00.000Z") },
    });
    await prisma.actionable.update({
      where: { id: manuallyBlocked.id },
      data: { updatedAt: new Date("2031-01-01T00:00:00.000Z") },
    });

    await expect(
      listAgentTasks(prisma, {
        agentId: "agent:session",
        view: "available",
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const available = await listAgentTasks(prisma, {
      agentId: "agent:session",
      view: "available",
      workItemId: root.sourceOrdinal,
      limit: 1,
    });
    expect(available.items.map((item) => item.id)).toEqual([
      root.sourceOrdinal,
    ]);

    await expect(
      claimAgentTask(prisma, unrelated.sourceOrdinal, {
        agentId: "agent:session",
        workItemId: root.sourceOrdinal,
        version: unrelated.version,
        leaseMinutes: 30,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await prisma.actionable.update({
      where: { id: unrelated.id },
      data: { status: "Done" },
    });
    const unblockedAvailable = await listAgentTasks(prisma, {
      agentId: "agent:session",
      view: "available",
      workItemId: root.sourceOrdinal,
      limit: 100,
    });
    expect(
      unblockedAvailable.items.map((item) => item.id).sort((a, b) => a - b),
    ).toEqual([root.sourceOrdinal, child.sourceOrdinal].sort((a, b) => a - b));
    expect(
      unblockedAvailable.items.find((item) => item.id === child.sourceOrdinal),
    ).toMatchObject({
      workItemId: root.sourceOrdinal,
      parentId: root.sourceOrdinal,
      findingExcerpt: "A focused finding for the feature task.",
      tags: ["feature", "agent"],
      isEffectivelyBlocked: false,
      unresolvedDependencyCount: 0,
    });

    await claimAgentTask(prisma, child.sourceOrdinal, {
      agentId: "agent:session",
      workItemId: root.sourceOrdinal,
      version: unblockedAvailable.items.find(
        (item) => item.id === child.sourceOrdinal,
      )!.version,
      leaseMinutes: 30,
    });
    const mine = await listAgentTasks(prisma, {
      agentId: "agent:session",
      view: "mine",
      workItemId: root.sourceOrdinal,
      limit: 100,
    });
    expect(mine.items.map((item) => item.id)).toEqual([child.sourceOrdinal]);
  });

  it("stores only a token hash, increments version, and records a bounded claim event", async () => {
    const task = await createTask();
    const claimed = await claimAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        agentId: "agent:hash",
        workItemId: task.sourceOrdinal,
        version: task.version,
        leaseMinutes: 30,
      },
      new Date("2026-07-25T12:00:00.000Z"),
    );
    const stored = await prisma.agentTaskClaim.findUniqueOrThrow({
      where: { actionableId: task.id },
    });
    expect(stored.claimTokenHash).not.toBe(claimed.claim.claimToken);
    expect(stored.claimTokenHash).toBe(
      createHash("sha256")
        .update(claimed.claim.claimToken, "utf8")
        .digest("hex"),
    );
    expect(claimed.task).toMatchObject({
      status: "Ready",
      version: task.version + 1,
      claim: { agentId: "agent:hash" },
    });
    const events = await prisma.activityEvent.findMany({
      where: { actionableId: task.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent-claimed",
      summary: "Claimed by agent agent:hash",
      metadataJson: { agentId: "agent:hash" },
    });
  });

  it("allows one agent to hold multiple claims", async () => {
    const first = await createTask();
    const second = await createTask();
    const claims = await Promise.all(
      [first, second].map((task) =>
        claimAgentTask(prisma, task.sourceOrdinal, {
          agentId: "agent:multi",
          workItemId: task.sourceOrdinal,
          version: task.version,
          leaseMinutes: 30,
        }),
      ),
    );
    expect(claims).toHaveLength(2);
    expect(
      await prisma.agentTaskClaim.count({
        where: { agentId: "agent:multi" },
      }),
    ).toBe(2);
  });

  it("permits only one winner when agents race to claim the same version", async () => {
    const task = await createTask();
    const secondPrisma = createPrismaClient(databaseUrl);
    try {
      const results = await Promise.allSettled([
        claimAgentTask(prisma, task.sourceOrdinal, {
          agentId: "agent:race-a",
          workItemId: task.sourceOrdinal,
          version: task.version,
          leaseMinutes: 30,
        }),
        claimAgentTask(secondPrisma, task.sourceOrdinal, {
          agentId: "agent:race-b",
          workItemId: task.sourceOrdinal,
          version: task.version,
          leaseMinutes: 30,
        }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expectClaimError(rejected?.reason, "ALREADY_CLAIMED");
      expect(
        await prisma.agentTaskClaim.count({
          where: { actionableId: task.id },
        }),
      ).toBe(1);
    } finally {
      await secondPrisma.$disconnect();
    }
  });

  it("recovers a same-thread claim by rotating the token and renewing the lease", async () => {
    const threadId = "019fa45f-581d-7bc0-afe3-a2b65171df62";
    const task = await createTask();
    const claimed = await claimAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        agentId: `codex:${threadId}`,
        workItemId: task.sourceOrdinal,
        version: task.version,
        leaseMinutes: 30,
      },
      new Date("2026-07-25T12:00:00.000Z"),
    );

    const recovered = await recoverAgentTaskClaim(
      prisma,
      task.sourceOrdinal,
      { version: claimed.task.version, leaseMinutes: 60 },
      { threadId },
      new Date("2026-07-25T12:10:00.000Z"),
    );

    expect(recovered.task.version).toBe(claimed.task.version + 1);
    expect(recovered.claim).toMatchObject({
      agentId: `codex:${threadId}`,
      claimedAt: claimed.claim.claimedAt,
      renewedAt: "2026-07-25T12:10:00.000Z",
      leaseExpiresAt: "2026-07-25T13:10:00.000Z",
    });
    expect(recovered.claim.claimToken).not.toBe(claimed.claim.claimToken);
    const stored = await prisma.agentTaskClaim.findUniqueOrThrow({
      where: { actionableId: task.id },
    });
    expect(stored.claimTokenHash).toBe(
      createHash("sha256")
        .update(recovered.claim.claimToken, "utf8")
        .digest("hex"),
    );
    expect(stored.claimTokenHash).not.toBe(
      createHash("sha256")
        .update(claimed.claim.claimToken, "utf8")
        .digest("hex"),
    );
    await expect(
      updateClaimedAgentTask(
        prisma,
        task.sourceOrdinal,
        {
          claimToken: claimed.claim.claimToken,
          version: recovered.task.version,
          title: "Must not persist with superseded credentials",
        },
        new Date("2026-07-25T12:11:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CLAIM_TOKEN" });
    const updated = await updateClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: recovered.claim.claimToken,
        version: recovered.task.version,
        title: "Recovered credentials work",
      },
      new Date("2026-07-25T12:11:00.000Z"),
    );
    expect(updated.title).toBe("Recovered credentials work");
    expect(
      await prisma.activityEvent.findFirst({
        where: {
          actionableId: task.id,
          type: "agent-updated",
          summary: `Recovered claim credential for agent codex:${threadId}`,
        },
      }),
    ).toMatchObject({
      metadataJson: {
        agentId: `codex:${threadId}`,
        origin: `agent:codex:${threadId}`,
        operation: "claim-recovery",
      },
    });
  });

  it("rejects other-thread recovery and permits one concurrent rotation winner", async () => {
    const threadId = "019fa45f-581d-7bc0-afe3-a2b65171df64";
    const task = await createTask();
    const claimed = await claimAgentTask(prisma, task.sourceOrdinal, {
      agentId: `codex:${threadId}`,
      workItemId: task.sourceOrdinal,
      version: task.version,
      leaseMinutes: 30,
    });
    await expect(
      recoverAgentTaskClaim(
        prisma,
        task.sourceOrdinal,
        { version: claimed.task.version, leaseMinutes: 30 },
        { threadId: "019fa45f-581d-7bc0-afe3-a2b65171df65" },
      ),
    ).rejects.toMatchObject({ code: "CLAIM_OWNER_MISMATCH" });

    const secondPrisma = createPrismaClient(databaseUrl);
    try {
      const results = await Promise.allSettled([
        recoverAgentTaskClaim(
          prisma,
          task.sourceOrdinal,
          { version: claimed.task.version, leaseMinutes: 30 },
          { threadId },
        ),
        recoverAgentTaskClaim(
          secondPrisma,
          task.sourceOrdinal,
          { version: claimed.task.version, leaseMinutes: 30 },
          { threadId },
        ),
      ]);
      const fulfilled = results.filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof recoverAgentTaskClaim>>
        > => result.status === "fulfilled",
      );
      expect(fulfilled).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expectClaimError(rejected?.reason, "VERSION_CONFLICT");
      expect(
        await prisma.agentTaskClaim.count({
          where: { actionableId: task.id },
        }),
      ).toBe(1);
      const stored = await prisma.agentTaskClaim.findUniqueOrThrow({
        where: { actionableId: task.id },
      });
      expect(stored.claimTokenHash).toBe(
        createHash("sha256")
          .update(fulfilled[0]!.value.claim.claimToken, "utf8")
          .digest("hex"),
      );
    } finally {
      await secondPrisma.$disconnect();
    }
  });

  it("requires normal reclaim after a recovery observes expiry", async () => {
    const threadId = "019fa45f-581d-7bc0-afe3-a2b65171df66";
    const task = await createTask();
    const claimed = await claimAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        agentId: `codex:${threadId}`,
        workItemId: task.sourceOrdinal,
        version: task.version,
        leaseMinutes: 5,
      },
      new Date("2026-07-25T12:00:00.000Z"),
    );
    await expect(
      recoverAgentTaskClaim(
        prisma,
        task.sourceOrdinal,
        { version: claimed.task.version, leaseMinutes: 30 },
        { threadId },
        new Date("2026-07-25T12:06:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
    expect(
      await prisma.agentTaskClaim.findUnique({
        where: { actionableId: task.id },
      }),
    ).toBeNull();
  });

  it("dismisses a same-thread unclaimed task and reconciles an expired claim", async () => {
    const creatorThreadId = "019fa45f-581d-7bc0-afe3-a2b65171df62";
    const task = await createTask({
      status: "Inbox",
      creatorThreadId,
    });
    const dismissed = await dismissAgentTask(
      prisma,
      task.sourceOrdinal,
      { reason: "Disposable task created by this Codex thread." },
      { threadId: creatorThreadId },
    );
    expect(dismissed).toMatchObject({
      status: "Dismissed",
      version: task.version + 1,
    });
    expect(dismissed.statusHistory.at(-1)).toMatchObject({
      previousStatus: "Inbox",
      newStatus: "Dismissed",
      origin: `agent:codex:${creatorThreadId}`,
    });
    expect(dismissed.activity.at(-1)).toMatchObject({
      type: "dismissed",
      context: expect.objectContaining({
        reason: "Disposable task created by this Codex thread.",
        origin: `agent:codex:${creatorThreadId}`,
      }),
    });

    const expiredTask = await createTask({
      status: "Inbox",
      creatorThreadId,
    });
    await claimAgentTask(
      prisma,
      expiredTask.sourceOrdinal,
      {
        agentId: `codex:${creatorThreadId}`,
        workItemId: expiredTask.sourceOrdinal,
        version: expiredTask.version,
        leaseMinutes: 5,
      },
      new Date("2026-07-25T12:00:00.000Z"),
    );
    const dismissedAfterExpiry = await dismissAgentTask(
      prisma,
      expiredTask.sourceOrdinal,
      { reason: "The creator thread no longer needs this expired task." },
      { threadId: creatorThreadId },
      new Date("2026-07-25T12:06:00.000Z"),
    );
    expect(dismissedAfterExpiry).toMatchObject({
      status: "Dismissed",
      version: expiredTask.version + 3,
    });
    expect(
      await prisma.agentTaskClaim.findUnique({
        where: { actionableId: expiredTask.id },
      }),
    ).toBeNull();
    expect(
      (
        await prisma.activityEvent.findMany({
          where: { actionableId: expiredTask.id },
          orderBy: { occurredAt: "asc" },
        })
      ).map((event) => event.type),
    ).toEqual(["agent-claimed", "agent-claim-expired", "dismissed"]);
  });

  it("rejects invalid creator-thread dismissal targets without changing state", async () => {
    const creatorThreadId = "019fa45f-581d-7bc0-afe3-a2b65171df62";
    const caller = { threadId: creatorThreadId };
    const wrongThread = await createTask({
      status: "Inbox",
      creatorThreadId,
    });
    await expect(
      dismissAgentTask(
        prisma,
        wrongThread.sourceOrdinal,
        { reason: "Must not save." },
        { threadId: "019fa45f-581d-7bc0-afe3-a2b65171df63" },
      ),
    ).rejects.toMatchObject({ code: "CREATOR_THREAD_MISMATCH" });

    const liveClaim = await createTask({
      status: "Inbox",
      creatorThreadId,
    });
    await claimAgentTask(prisma, liveClaim.sourceOrdinal, {
      agentId: `codex:${creatorThreadId}`,
      workItemId: liveClaim.sourceOrdinal,
      version: liveClaim.version,
      leaseMinutes: 30,
    });
    await expect(
      dismissAgentTask(
        prisma,
        liveClaim.sourceOrdinal,
        { reason: "Claimed work must use transition_task." },
        caller,
      ),
    ).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });

    const archived = await createTask({
      status: "Inbox",
      archivedAt: new Date(),
      creatorThreadId,
    });
    const terminal = await createTask({
      status: "Done",
      creatorThreadId,
    });
    const missingCreator = await createTask({ status: "Inbox" });
    await expect(
      dismissAgentTask(
        prisma,
        archived.sourceOrdinal,
        { reason: "Must not save." },
        caller,
      ),
    ).rejects.toMatchObject({ code: "ARCHIVED" });
    await expect(
      dismissAgentTask(
        prisma,
        terminal.sourceOrdinal,
        { reason: "Must not save." },
        caller,
      ),
    ).rejects.toMatchObject({ code: "TERMINAL" });
    await expect(
      dismissAgentTask(
        prisma,
        missingCreator.sourceOrdinal,
        { reason: "Must not save." },
        caller,
      ),
    ).rejects.toMatchObject({ code: "CREATOR_THREAD_MISMATCH" });
    await expect(
      dismissAgentTask(prisma, wrongThread.sourceOrdinal, {} as never, caller),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(
      await prisma.actionable.count({
        where: {
          id: {
            in: [
              wrongThread.id,
              liveClaim.id,
              archived.id,
              terminal.id,
              missingCreator.id,
            ],
          },
          status: "Dismissed",
        },
      }),
    ).toBe(0);
  });

  it("permits only one winner when claim and creator dismissal race", async () => {
    const creatorThreadId = "019fa45f-581d-7bc0-afe3-a2b65171df62";
    const task = await createTask({
      status: "Inbox",
      creatorThreadId,
    });
    const secondPrisma = createPrismaClient(databaseUrl);
    try {
      const results = await Promise.allSettled([
        claimAgentTask(prisma, task.sourceOrdinal, {
          agentId: `codex:${creatorThreadId}`,
          workItemId: task.sourceOrdinal,
          version: task.version,
          leaseMinutes: 30,
        }),
        dismissAgentTask(
          secondPrisma,
          task.sourceOrdinal,
          { reason: "Dismiss if the claim has not won." },
          { threadId: creatorThreadId },
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const stored = await prisma.actionable.findUniqueOrThrow({
        where: { id: task.id },
        include: { agentTaskClaim: true, statusHistory: true },
      });
      expect(
        (stored.status === "Dismissed" && stored.agentTaskClaim === null) ||
          (stored.status === "Inbox" && stored.agentTaskClaim !== null),
      ).toBe(true);
      expect(
        stored.statusHistory.filter((entry) => entry.newStatus === "Dismissed"),
      ).toHaveLength(stored.status === "Dismissed" ? 1 : 0);
    } finally {
      await secondPrisma.$disconnect();
    }
  });

  it("rejects stale, archived, terminal, and wrong-token operations", async () => {
    const stale = await createTask();
    await expect(
      claimAgentTask(prisma, stale.sourceOrdinal, {
        agentId: "agent:errors",
        workItemId: stale.sourceOrdinal,
        version: stale.version + 1,
        leaseMinutes: 30,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const archived = await createTask({ archivedAt: new Date() });
    await expect(
      claimAgentTask(prisma, archived.sourceOrdinal, {
        agentId: "agent:errors",
        workItemId: archived.sourceOrdinal,
        version: archived.version,
        leaseMinutes: 30,
      }),
    ).rejects.toMatchObject({ code: "ARCHIVED" });

    const terminal = await createTask({ status: "Dismissed" });
    await expect(
      claimAgentTask(prisma, terminal.sourceOrdinal, {
        agentId: "agent:errors",
        workItemId: terminal.sourceOrdinal,
        version: terminal.version,
        leaseMinutes: 30,
      }),
    ).rejects.toMatchObject({ code: "TERMINAL" });

    const task = await createTask();
    const claimed = await claimAgentTask(prisma, task.sourceOrdinal, {
      agentId: "agent:owner",
      workItemId: task.sourceOrdinal,
      version: task.version,
      leaseMinutes: 30,
    });
    await expect(
      releaseAgentTaskClaim(prisma, task.sourceOrdinal, {
        claimToken: "x".repeat(43),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CLAIM_TOKEN" });
  });

  it("renews within bounds without activity noise and releases with activity", async () => {
    const task = await createTask();
    const now = new Date("2026-07-25T12:00:00.000Z");
    const claimed = await claimAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        agentId: "agent:lease",
        workItemId: task.sourceOrdinal,
        version: task.version,
        leaseMinutes: 30,
      },
      now,
    );
    await expect(
      renewAgentTaskClaim(prisma, task.sourceOrdinal, {
        claimToken: claimed.claim.claimToken,
        leaseMinutes: 121,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const renewed = await renewAgentTaskClaim(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: claimed.claim.claimToken,
        leaseMinutes: 60,
      },
      new Date("2026-07-25T12:10:00.000Z"),
    );
    expect(renewed.task.claim?.leaseExpiresAt).toBe("2026-07-25T13:10:00.000Z");
    expect(renewed.task.version).toBe(claimed.task.version);
    expect(
      await prisma.activityEvent.count({ where: { actionableId: task.id } }),
    ).toBe(1);

    const released = await releaseAgentTaskClaim(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: claimed.claim.claimToken,
      },
      new Date("2026-07-25T12:11:00.000Z"),
    );
    expect(released.task.claim).toBeNull();
    expect(released.task.version).toBe(claimed.task.version + 1);
    expect(
      (
        await prisma.activityEvent.findMany({
          where: { actionableId: task.id },
          orderBy: { occurredAt: "asc" },
        })
      ).map((event) => event.type),
    ).toEqual(["agent-claimed", "agent-released"]);
  });

  it("force releases the confirmed claim without changing lifecycle state", async () => {
    const task = await createTask({ status: "Researching" });
    const claimed = await claimAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        agentId: "agent:force-release",
        workItemId: task.sourceOrdinal,
        version: task.version,
        leaseMinutes: 30,
      },
      new Date("2026-07-29T01:00:00.000Z"),
    );

    const released = await forceReleaseAgentTaskClaim(
      prisma,
      task.sourceOrdinal,
      {
        version: claimed.task.version,
        agentId: claimed.claim.agentId,
        claimedAt: claimed.claim.claimedAt,
      },
      new Date("2026-07-29T01:05:00.000Z"),
    );
    expect(released).toMatchObject({
      status: "Researching",
      version: claimed.task.version + 1,
      agentClaim: null,
    });
    expect(released.activity.at(-1)).toMatchObject({
      type: "agent-released",
      summary: "Force-released by user from agent agent:force-release",
      context: {
        agentId: "agent:force-release",
        claimedAt: claimed.claim.claimedAt,
        origin: "user",
        operation: "force-release",
      },
    });
    await expect(
      renewAgentTaskClaim(
        prisma,
        task.sourceOrdinal,
        {
          claimToken: claimed.claim.claimToken,
          leaseMinutes: 30,
        },
        new Date("2026-07-29T01:06:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CLAIM_TOKEN" });

    const replacement = await claimAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        agentId: "agent:replacement",
        workItemId: task.sourceOrdinal,
        version: released.version,
        leaseMinutes: 30,
      },
      new Date("2026-07-29T01:07:00.000Z"),
    );
    await expect(
      forceReleaseAgentTaskClaim(
        prisma,
        task.sourceOrdinal,
        {
          version: replacement.task.version,
          agentId: claimed.claim.agentId,
          claimedAt: claimed.claim.claimedAt,
        },
        new Date("2026-07-29T01:08:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "CLAIM_CHANGED" });
    const storedReplacement = await prisma.agentTaskClaim.findUniqueOrThrow({
      where: { actionableId: task.id },
    });
    expect(storedReplacement.agentId).toBe("agent:replacement");
    expect(storedReplacement.claimTokenHash).toBe(
      createHash("sha256")
        .update(replacement.claim.claimToken, "utf8")
        .digest("hex"),
    );
  });

  it("atomically saves handoff state and releases only after every write succeeds", async () => {
    const task = await createTask({
      finding: "Original finding",
      validation: ["Run the existing check."],
    });
    const claimed = await claimAgentTask(prisma, task.sourceOrdinal, {
      agentId: "agent:handoff",
      workItemId: task.sourceOrdinal,
      version: task.version,
      leaseMinutes: 30,
    });
    const inProgress = await transitionClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: claimed.claim.claimToken,
        version: claimed.task.version,
        status: "In progress",
      },
    );

    await expect(
      handoffClaimedAgentTask(prisma, task.sourceOrdinal, {
        claimToken: claimed.claim.claimToken,
        version: inProgress.version,
        finding: "Must roll back",
        addFiles: [{ path: "src/rolled-back.ts" }],
        validation: {
          type: "Command",
          outcome: "Passed",
          notes: "",
          evidence: "",
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_EVIDENCE_REQUIRED" });
    const afterFailure = await prisma.actionable.findUniqueOrThrow({
      where: { id: task.id },
      include: { agentTaskClaim: true },
    });
    expect(afterFailure).toMatchObject({
      version: inProgress.version,
      finding: "Original finding",
      filesJson: [],
      agentTaskClaim: expect.objectContaining({
        agentId: "agent:handoff",
      }),
    });

    const handedOff = await handoffClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: claimed.claim.claimToken,
        version: inProgress.version,
        finding: "The implementation is ready for review.",
        addFiles: [
          {
            path: "apps/api/src/agent-tasks.ts",
            symbol: "handoffClaimedAgentTask",
          },
          {
            path: "apps/api/src/agent-tasks.ts",
            symbol: "handoffClaimedAgentTask",
          },
        ],
        appendResearch: ["The claimed mutation is the atomic boundary."],
        appendPlannedValidation: ["Run the focused handoff test."],
        validation: {
          type: "Command",
          outcome: "Passed",
          notes: "Focused handoff coverage passed.",
          evidence: "vitest exited 0.",
        },
      },
      new Date("2026-07-25T12:15:00.000Z"),
    );

    expect(handedOff).toMatchObject({
      version: inProgress.version + 2,
      finding: "The implementation is ready for review.",
      research: ["The claimed mutation is the atomic boundary."],
      validation: ["Run the existing check.", "Run the focused handoff test."],
      files: [
        {
          path: "apps/api/src/agent-tasks.ts",
          symbol: "handoffClaimedAgentTask",
        },
      ],
      agentClaim: null,
    });
    expect(handedOff.validationRecords.at(-1)).toMatchObject({
      outcome: "Passed",
      origin: "agent:agent:handoff",
      qualifiesForCompletion: true,
    });
    expect(
      await prisma.agentTaskClaim.findUnique({
        where: { actionableId: task.id },
      }),
    ).toBeNull();
    expect(
      (
        await prisma.activityEvent.findMany({
          where: { actionableId: task.id },
          orderBy: { occurredAt: "asc" },
        })
      ).map((event) => event.type),
    ).toEqual(
      expect.arrayContaining([
        "agent-updated",
        "validation-recorded",
        "agent-released",
      ]),
    );
  });

  it("reclaims expired leases and records the observed expiry", async () => {
    const task = await createTask();
    const first = await claimAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        agentId: "agent:expired",
        workItemId: task.sourceOrdinal,
        version: task.version,
        leaseMinutes: 5,
      },
      new Date("2026-07-25T12:00:00.000Z"),
    );
    const reclaimed = await claimAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        agentId: "agent:new",
        workItemId: task.sourceOrdinal,
        version: first.task.version,
        leaseMinutes: 30,
      },
      new Date("2026-07-25T12:06:00.000Z"),
    );
    expect(reclaimed.task).toMatchObject({
      version: first.task.version + 1,
      claim: { agentId: "agent:new" },
    });
    expect(
      (
        await prisma.activityEvent.findMany({
          where: { actionableId: task.id },
          orderBy: { occurredAt: "asc" },
        })
      ).map((event) => event.type),
    ).toEqual(["agent-claimed", "agent-claim-expired", "agent-claimed"]);
  });

  it("updates only requested content, preserves server-managed fields, and renews the lease", async () => {
    const task = await createTask({ title: "Preserve me" });
    await prisma.actionable.update({
      where: { id: task.id },
      data: {
        finding: "Original finding",
        description: "Original description",
        researchJson: json(["Original research"]),
        validationJson: json(["Original validation"]),
        filesJson: json([{ path: "src/preserved.ts", lines: "1-10" }]),
        tagsJson: json(["original"]),
        rawFragmentJson: json({ immutable: "source evidence" }),
      },
    });
    await prisma.userSourceReference.create({
      data: {
        actionableId: task.id,
        type: "URL",
        locator: "https://example.com/preserved",
        label: "Preserved source",
      },
    });
    const claimed = await claimAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        agentId: "codex:partial",
        workItemId: task.sourceOrdinal,
        version: task.version,
        leaseMinutes: 30,
      },
      new Date("2026-07-25T12:00:00.000Z"),
    );
    const updated = await updateClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: claimed.claim.claimToken,
        version: claimed.task.version,
        title: "Updated title",
        research: ["New research"],
      },
      new Date("2026-07-25T12:10:00.000Z"),
    );

    expect(updated).toMatchObject({
      title: "Updated title",
      finding: "Original finding",
      description: "Original description",
      research: ["New research"],
      validation: ["Original validation"],
      tags: ["original"],
      status: "Ready",
      scope: {
        projectId: scope.projectId,
        repositoryId: scope.repositoryId,
        worktreeId: scope.worktreeId,
      },
    });
    expect(updated.files).toEqual([
      { path: "src/preserved.ts", lines: "1-10" },
    ]);
    expect(updated.userSources).toEqual([
      expect.objectContaining({
        locator: "https://example.com/preserved",
        label: "Preserved source",
      }),
    ]);
    const stored = await prisma.actionable.findUniqueOrThrow({
      where: { id: task.id },
      include: { agentTaskClaim: true },
    });
    expect(stored.rawFragmentJson).toEqual({ immutable: "source evidence" });
    expect(stored.agentTaskClaim?.leaseExpiresAt.toISOString()).toBe(
      "2026-07-25T12:40:00.000Z",
    );
    expect(
      await prisma.activityEvent.findFirst({
        where: { actionableId: task.id, type: "agent-updated" },
      }),
    ).toMatchObject({
      summary: "Updated by agent codex:partial",
      metadataJson: {
        origin: "agent:codex:partial",
        fields: "title,research",
      },
    });

    const updatedPlanAndSources = await updateClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: claimed.claim.claimToken,
        version: updated.version,
        plannedValidation: ["Run the replacement focused check."],
        userSources: [
          {
            type: "URL",
            locator: "https://example.com/preserved",
            label: "Preserved source",
          },
          {
            type: "Command",
            locator: "pnpm test",
            label: "Focused suite",
          },
        ],
      },
      new Date("2026-07-25T12:11:00.000Z"),
    );
    expect(updatedPlanAndSources.validation).toEqual([
      "Run the replacement focused check.",
    ]);
    expect(updatedPlanAndSources.userSources).toHaveLength(2);

    const appended = await updateClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: claimed.claim.claimToken,
        version: updatedPlanAndSources.version,
        appendResearch: [
          "New research",
          "Additional research",
          "Additional research",
        ],
        appendPlannedValidation: ["Run the second focused check."],
        addUserSources: [
          {
            type: "Command",
            locator: "pnpm test",
            label: "Focused suite",
          },
          {
            type: "Commit",
            locator: "abc123",
            label: "Implemented change",
          },
        ],
      },
      new Date("2026-07-25T12:12:00.000Z"),
    );
    expect(appended.research).toEqual(["New research", "Additional research"]);
    expect(appended.validation).toEqual([
      "Run the replacement focused check.",
      "Run the second focused check.",
    ]);
    expect(appended.userSources).toHaveLength(3);
    expect(
      appended.userSources.filter((source) => source.locator === "pnpm test"),
    ).toHaveLength(1);

    await expect(
      updateClaimedAgentTask(
        prisma,
        task.sourceOrdinal,
        {
          claimToken: claimed.claim.claimToken,
          version: appended.version,
          research: ["Replacement"],
          appendResearch: ["Ambiguous append"],
        },
        new Date("2026-07-25T12:13:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      updateClaimedAgentTask(
        prisma,
        task.sourceOrdinal,
        {
          claimToken: claimed.claim.claimToken,
          version: appended.version,
          appendResearch: Array.from(
            { length: 200 },
            (_, index) => `Research ${index}`,
          ),
        },
        new Date("2026-07-25T12:14:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("serializes claimed mutations and returns the winning current version", async () => {
    const task = await createTask();
    const claimed = await claimAgentTask(prisma, task.sourceOrdinal, {
      agentId: "codex:race",
      workItemId: task.sourceOrdinal,
      version: task.version,
      leaseMinutes: 30,
    });
    const base = {
      claimToken: claimed.claim.claimToken,
      version: claimed.task.version,
    };
    const results = await Promise.allSettled([
      updateClaimedAgentTask(prisma, task.sourceOrdinal, {
        ...base,
        title: "Race winner A",
      }),
      updateClaimedAgentTask(prisma, task.sourceOrdinal, {
        ...base,
        title: "Race winner B",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expectClaimError(rejected?.reason, "VERSION_CONFLICT");
    expect((rejected?.reason as AgentTaskClaimError).currentVersion).toBe(
      claimed.task.version + 1,
    );

    await expect(
      updateClaimedAgentTask(prisma, task.sourceOrdinal, {
        ...base,
        version: claimed.task.version + 1,
        agentId: "codex:not-owner",
        title: "Must not persist",
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      updateClaimedAgentTask(prisma, task.sourceOrdinal, {
        ...base,
        version: claimed.task.version + 1,
        claimToken: "x".repeat(43),
        title: "Must not persist",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CLAIM_TOKEN" });

    const expiringTask = await createTask();
    const expiringClaim = await claimAgentTask(
      prisma,
      expiringTask.sourceOrdinal,
      {
        agentId: "codex:expired-mutation",
        workItemId: expiringTask.sourceOrdinal,
        version: expiringTask.version,
        leaseMinutes: 5,
      },
      new Date("2026-07-25T12:00:00.000Z"),
    );
    await expect(
      updateClaimedAgentTask(
        prisma,
        expiringTask.sourceOrdinal,
        {
          claimToken: expiringClaim.claim.claimToken,
          version: expiringClaim.task.version,
          title: "Must not persist after expiry",
        },
        new Date("2026-07-25T12:06:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
    expect(
      await prisma.agentTaskClaim.findUnique({
        where: { actionableId: expiringTask.id },
      }),
    ).toBeNull();
  });

  it("requires claimed work to record research before implementation", async () => {
    const task = await createTask({
      status: "Inbox",
      finding: "The lifecycle needs a research-first guard.",
      description: "Require research before implementation.",
      validation: ["Run the focused lifecycle tests."],
    });
    const claimed = await claimAgentTask(prisma, task.sourceOrdinal, {
      agentId: "codex:research-first",
      workItemId: task.sourceOrdinal,
      version: task.version,
      leaseMinutes: 30,
    });
    const credentials = { claimToken: claimed.claim.claimToken };

    await expect(
      transitionClaimedAgentTask(prisma, task.sourceOrdinal, {
        ...credentials,
        version: claimed.task.version,
        status: "Ready",
      }),
    ).rejects.toMatchObject({ code: "RESEARCH_PHASE_REQUIRED" });

    const researching = await transitionClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        ...credentials,
        version: claimed.task.version,
        status: "Researching",
      },
    );
    await expect(
      transitionClaimedAgentTask(prisma, task.sourceOrdinal, {
        ...credentials,
        version: researching.version,
        status: "Ready",
      }),
    ).rejects.toMatchObject({ code: "RESEARCH_REQUIRED" });

    const researched = await updateClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        ...credentials,
        version: researching.version,
        appendResearch: [
          "The shared transition guard is the correct boundary.",
        ],
      },
    );
    const ready = await transitionClaimedAgentTask(prisma, task.sourceOrdinal, {
      ...credentials,
      version: researched.version,
      status: "Ready",
    });
    const inProgress = await transitionClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        ...credentials,
        version: ready.version,
        status: "In progress",
      },
    );
    expect(inProgress.status).toBe("In progress");
  });

  it("preserves lifecycle and validation rules, agent origins, renewal, and terminal release", async () => {
    const task = await createTask({ status: "Ready" });
    const claimed = await claimAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        agentId: "codex:lifecycle",
        workItemId: task.sourceOrdinal,
        version: task.version,
        leaseMinutes: 30,
      },
      new Date("2026-07-25T12:00:00.000Z"),
    );
    const inProgress = await transitionClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: claimed.claim.claimToken,
        version: claimed.task.version,
        status: "In progress",
      },
      new Date("2026-07-25T12:05:00.000Z"),
    );
    expect(inProgress.status).toBe("In progress");
    expect(
      (
        await prisma.agentTaskClaim.findUniqueOrThrow({
          where: { actionableId: task.id },
        })
      ).leaseExpiresAt.toISOString(),
    ).toBe("2026-07-25T12:35:00.000Z");

    await expect(
      transitionClaimedAgentTask(
        prisma,
        task.sourceOrdinal,
        {
          claimToken: claimed.claim.claimToken,
          version: inProgress.version,
          status: "Done",
        },
        new Date("2026-07-25T12:06:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_REQUIRED" });
    await expect(
      recordClaimedAgentTaskValidation(
        prisma,
        task.sourceOrdinal,
        {
          claimToken: claimed.claim.claimToken,
          version: inProgress.version,
          type: "Command",
          outcome: "Passed",
          notes: "",
          evidence: "",
        },
        new Date("2026-07-25T12:07:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_EVIDENCE_REQUIRED" });
    expect(
      (
        await prisma.agentTaskClaim.findUniqueOrThrow({
          where: { actionableId: task.id },
        })
      ).leaseExpiresAt.toISOString(),
    ).toBe("2026-07-25T12:35:00.000Z");

    const validated = await recordClaimedAgentTaskValidation(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: claimed.claim.claimToken,
        version: inProgress.version,
        type: "Command",
        outcome: "Passed",
        notes: "Focused checks passed.",
        evidence: "pnpm test exited 0.",
      },
      new Date("2026-07-25T12:08:00.000Z"),
    );
    expect(validated.validationRecords.at(-1)).toMatchObject({
      origin: "agent:codex:lifecycle",
      qualifiesForCompletion: true,
    });
    expect(
      (
        await prisma.agentTaskClaim.findUniqueOrThrow({
          where: { actionableId: task.id },
        })
      ).leaseExpiresAt.toISOString(),
    ).toBe("2026-07-25T12:38:00.000Z");
    const completed = await transitionClaimedAgentTask(
      prisma,
      task.sourceOrdinal,
      {
        claimToken: claimed.claim.claimToken,
        version: validated.version,
        status: "Done",
      },
      new Date("2026-07-25T12:09:00.000Z"),
    );
    expect(completed.status).toBe("Done");
    expect(completed.statusHistory.at(-1)).toMatchObject({
      origin: "agent:codex:lifecycle",
    });
    expect(
      await prisma.agentTaskClaim.findUnique({
        where: { actionableId: task.id },
      }),
    ).toBeNull();
    expect(
      (
        await prisma.activityEvent.findMany({
          where: { actionableId: task.id },
          orderBy: { occurredAt: "asc" },
        })
      ).map((event) => event.type),
    ).toContain("agent-released");

    const dismissedTask = await createTask({ status: "Inbox" });
    const dismissedClaim = await claimAgentTask(
      prisma,
      dismissedTask.sourceOrdinal,
      {
        agentId: "codex:dismiss",
        workItemId: dismissedTask.sourceOrdinal,
        version: dismissedTask.version,
        leaseMinutes: 30,
      },
    );
    const dismissed = await transitionClaimedAgentTask(
      prisma,
      dismissedTask.sourceOrdinal,
      {
        claimToken: dismissedClaim.claim.claimToken,
        version: dismissedClaim.task.version,
        status: "Dismissed",
        reason: "This work is no longer needed.",
      },
    );
    expect(dismissed.status).toBe("Dismissed");
    expect(
      await prisma.agentTaskClaim.findUnique({
        where: { actionableId: dismissedTask.id },
      }),
    ).toBeNull();
  });

  it("excludes claim credentials and lease state from portable export", async () => {
    const task = await createTask();
    const claimed = await claimAgentTask(prisma, task.sourceOrdinal, {
      agentId: "agent:export",
      workItemId: task.sourceOrdinal,
      version: task.version,
      leaseMinutes: 30,
    });
    const document = await exportPortableDocument(prisma);
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain(claimed.claim.claimToken);
    expect(serialized).not.toContain("claimTokenHash");
    expect(serialized).not.toContain("leaseExpiresAt");
    expect(
      document.activities.some(
        (activity) =>
          activity.actionableId === task.externalKey &&
          activity.type === "agent-claimed",
      ),
    ).toBe(true);
  });
});
