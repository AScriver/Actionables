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
let otherScope: { projectId: string; repositoryId: string; worktreeId: string };

beforeAll(async () => {
  const databaseName = `relationships-${randomUUID()}.db`;
  databasePath = resolve(repoRoot, "data", databaseName);
  const databaseUrl = `file:./data/${databaseName}`;
  const file = await open(databasePath, "a");
  await file.close();
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
  prisma = createPrismaClient(databaseUrl);
  const project = await prisma.project.create({
    data: { externalKey: "test-primary", name: "Primary" },
  });
  const repository = await prisma.repository.create({
    data: {
      externalKey: "test-primary-repo",
      name: "PrimaryRepo",
      projectId: project.id,
    },
  });
  const worktree = await prisma.worktree.create({
    data: {
      externalKey: "test-primary-tree",
      name: "main",
      projectId: project.id,
      repositoryId: repository.id,
    },
  });
  scope = {
    projectId: project.id,
    repositoryId: repository.id,
    worktreeId: worktree.id,
  };
  const otherProject = await prisma.project.create({
    data: { externalKey: "test-other", name: "Other" },
  });
  const otherRepository = await prisma.repository.create({
    data: {
      externalKey: "test-other-repo",
      name: "OtherRepo",
      projectId: otherProject.id,
    },
  });
  const otherWorktree = await prisma.worktree.create({
    data: {
      externalKey: "test-other-tree",
      name: "feature",
      projectId: otherProject.id,
      repositoryId: otherRepository.id,
    },
  });
  otherScope = {
    projectId: otherProject.id,
    repositoryId: otherRepository.id,
    worktreeId: otherWorktree.id,
  };
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

const body = (title: string, selectedScope = scope) => ({
  title,
  priority: "Unset",
  effort: "Unknown",
  evidenceState: "Unclassified",
  ...selectedScope,
  finding: "A bounded finding",
  description: "A bounded result",
  resolution:
    "Completed the relationship scenario and preserved its lifecycle rules.",
  research: ["The relationship lifecycle was reviewed."],
  validation: ["Verify it"],
  tags: [],
  userSources: [],
});

async function create(title: string, selectedScope = scope) {
  const response = await app.inject({
    method: "POST",
    url: "/api/actionables",
    payload: body(title, selectedScope),
  });
  expect(response.statusCode).toBe(201);
  return response.json().item;
}

async function get(id: number) {
  return (
    await app.inject({ method: "GET", url: `/api/actionables/${id}` })
  ).json().item;
}

async function move(
  item: { id: number; version: number },
  status: string,
  extra: Record<string, string> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/actionables/${item.id}/status-transitions`,
    payload: { version: item.version, status, origin: "user", ...extra },
  });
  expect(response.statusCode).toBe(200);
  return response.json().item;
}

describe("hierarchy relationships", () => {
  it.each(["direct", "nested"])(
    "rolls up %s tasks using real claim, dependency and validation state",
    async (shape) => {
      const parent = await create(`Progress rollup parent ${shape}`);
      expect(parent.directTaskProgress).toBeNull();
      const statuses = [
        "Done",
        "Dismissed",
        "In progress",
        "Blocked",
        "Ready",
        "Inbox",
      ];
      const children: Array<{ id: number; recordId: string }> = [];
      const phase = new Date(Date.now() - 60_000);
      for (const [index, status] of statuses.entries()) {
        const child = await create(`Progress child ${index}`);
        children.push(child);
        let parentId = parent.recordId;
        if (shape === "nested" && index >= 2) {
          parentId = children[Math.floor(index / 2)].recordId;
        }
        await prisma.hierarchyRelationship.create({
          data: { parentId, childId: child.recordId },
        });
        await prisma.actionable.update({
          where: { id: child.recordId },
          data: { status, ...(index === 5 ? { archivedAt: new Date() } : {}) },
        });
        await prisma.actionableStatusHistory.create({
          data: {
            actionableId: child.recordId,
            previousStatus: "Ready",
            newStatus: "In progress",
            origin: "fixture",
            occurredAt: phase,
          },
        });
      }
      for (const index of [2, 4])
        await prisma.agentTaskClaim.create({
          data: {
            actionableId: children[index].recordId,
            agentId: "rollup-fixture",
            claimTokenHash: randomUUID(),
            leaseExpiresAt: new Date(
              Date.now() + (index === 2 ? 60_000 : -60_000),
            ),
          },
        });
      const edge = await prisma.dependencyRelationship.create({
        data: {
          dependentId: children[4].recordId,
          prerequisiteId: children[1].recordId,
        },
      });
      const validation = (
        index: number,
        recordedAt: Date,
        outcome = "Passed",
        supersedesId?: string,
      ) =>
        prisma.validationRecord.create({
          data: {
            actionableId: children[index].recordId,
            type: "Automated test",
            outcome,
            notesMd: "Fixture",
            evidenceMd: "Fixture",
            origin: "fixture",
            recordedAt,
            supersedesId,
          },
        });
      await validation(0, new Date());
      await validation(2, new Date(phase.getTime() - 1));
      const superseded = await validation(3, new Date());
      await validation(3, new Date(), "Failed", superseded.id);
      expect((await get(parent.id)).directTaskProgress).toEqual({
        total: 6,
        completed: 1,
        dismissed: 1,
        open: 4,
        blocked: 2,
        unclaimed: 2,
        validationReady: 1,
      });
      const listed = await app.inject({
        method: "GET",
        url: `/api/actionables?q=${encodeURIComponent(parent.title)}`,
      });
      expect(
        listed
          .json()
          .items.find((item: { id: number }) => item.id === parent.id)
          .childCompletion,
      ).toEqual({ terminal: 2, total: 6 });
      if (shape === "nested") {
        expect((await get(children[1].id)).directTaskProgress).toMatchObject({
          total: 4,
          open: 4,
        });
      }
      await validation(2, new Date());
      await prisma.dependencyRelationship.update({
        where: { id: edge.id },
        data: { waivedAt: new Date(), waiverReason: "Fixture waiver" },
      });
      await prisma.agentTaskClaim.delete({
        where: { actionableId: children[4].recordId },
      });
      await prisma.hierarchyRelationship.updateMany({
        where: { childId: children[5].recordId },
        data: { detachedAt: new Date() },
      });
      expect((await get(parent.id)).directTaskProgress).toEqual({
        total: 5,
        completed: 1,
        dismissed: 1,
        open: 3,
        blocked: 1,
        unclaimed: 2,
        validationReady: 2,
      });
      expect((await get(children[0].id)).directTaskProgress).toBeNull();
    },
  );

  it.each([
    [
      "bug",
      [
        "Reproduce and isolate the bug",
        "Implement the fix",
        "Add regression coverage",
        "Validate affected behavior",
      ],
    ],
    [
      "feature",
      [
        "Define acceptance criteria",
        "Implement the feature",
        "Add automated coverage",
        "Validate the end-to-end flow",
      ],
    ],
    [
      "research",
      [
        "Define the research question",
        "Gather and assess evidence",
        "Document findings and recommendation",
      ],
    ],
    [
      "migration",
      [
        "Inventory affected data and compatibility",
        "Implement the migration and rollback path",
        "Test the migration on representative data",
        "Verify production readiness",
      ],
    ],
  ])("creates an atomic %s task breakdown", async (template, titles) => {
    const parent = await create(`${template} breakdown parent`);
    const response = await app.inject({
      method: "POST",
      url: `/api/actionables/${parent.id}/task-breakdowns`,
      payload: { version: parent.version, template },
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json().item;
    expect(saved.version).toBe(parent.version + 1);
    expect(
      saved.relationships.subtasks.map(
        (relationship: { child: { title: string } }) =>
          relationship.child.title,
      ),
    ).toEqual(titles);
    expect(
      saved.activity.some(
        (event: { type: string; context: Record<string, string> }) =>
          event.type === "task-breakdown-created" &&
          event.context.template === template &&
          event.context.subtasksCreated === String(titles.length),
      ),
    ).toBe(true);
  });

  it("rejects stale breakdowns and creates nested breakdowns atomically", async () => {
    const parent = await create("Task breakdown concurrency parent");
    const first = await app.inject({
      method: "POST",
      url: `/api/actionables/${parent.id}/task-breakdowns`,
      payload: { version: parent.version, template: "research" },
    });
    expect(first.statusCode, first.body).toBe(200);
    const actionableCount = await prisma.actionable.count();

    const stale = await app.inject({
      method: "POST",
      url: `/api/actionables/${parent.id}/task-breakdowns`,
      payload: { version: parent.version, template: "bug" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().current.relationships.subtasks).toHaveLength(3);
    expect(await prisma.actionable.count()).toBe(actionableCount);

    const child = first.json().item.relationships.subtasks[0].child;
    const nested = await app.inject({
      method: "POST",
      url: `/api/actionables/${child.id}/task-breakdowns`,
      payload: { version: child.version, template: "migration" },
    });
    expect(nested.statusCode, nested.body).toBe(200);
    expect(nested.json().item.relationships.subtasks).toHaveLength(4);
    expect(await prisma.actionable.count()).toBe(actionableCount + 4);
    expect((await get(parent.id)).relationships.subtasks).toHaveLength(3);
  });

  it("creates four levels, rejects cycles/scope/self/stale moves, and preserves moved subtrees and history", async () => {
    let parent = await create("Parent");
    let replacement = await create("Replacement");
    let child = await create("Child");
    const other = await create("Other scope child", otherScope);

    const attached = await app.inject({
      method: "PUT",
      url: `/api/actionables/${child.id}/parent`,
      payload: {
        version: child.version,
        parentId: parent.id,
        parentVersion: parent.version,
      },
    });
    expect(attached.statusCode).toBe(200);
    child = attached.json().item;
    parent = await get(parent.id);
    expect(child.relationships.parent.parent.id).toBe(parent.id);
    expect(parent.relationships.subtasks[0].child.id).toBe(child.id);

    const createChild = async (id: number, title: string) => {
      const current = await get(id);
      const response = await app.inject({
        method: "POST",
        url: `/api/actionables/${id}/subtasks`,
        payload: { version: current.version, title },
      });
      expect(response.statusCode, response.body).toBe(200);
      return get(response.json().item.relationships.subtasks.at(-1).child.id);
    };
    const grandchild = await createChild(child.id, "Grandchild");
    const greatGrandchild = await createChild(
      grandchild.id,
      "Great-grandchild",
    );
    child = await get(child.id);
    expect(greatGrandchild.scope).toEqual(parent.scope);
    expect(greatGrandchild.parentId).toBe(grandchild.id);
    expect((await get(grandchild.id)).parentId).toBe(child.id);

    const self = await app.inject({
      method: "PUT",
      url: `/api/actionables/${child.id}/parent`,
      payload: {
        version: child.version,
        parentId: child.id,
        parentVersion: child.version,
      },
    });
    expect(self.json().code).toBe("SELF_HIERARCHY");

    const cycle = await app.inject({
      method: "PUT",
      url: `/api/actionables/${parent.id}/parent`,
      payload: {
        version: parent.version,
        parentId: greatGrandchild.id,
        parentVersion: greatGrandchild.version,
      },
    });
    expect(cycle.json().code).toBe("HIERARCHY_CYCLE");
    expect((await get(parent.id)).parentId).toBeUndefined();

    const crossScope = await app.inject({
      method: "PUT",
      url: `/api/actionables/${other.id}/parent`,
      payload: {
        version: other.version,
        parentId: parent.id,
        parentVersion: parent.version,
      },
    });
    expect(crossScope.json().code).toBe("HIERARCHY_SCOPE_MISMATCH");

    replacement = await get(replacement.id);
    const staleMove = await app.inject({
      method: "PUT",
      url: `/api/actionables/${child.id}/parent`,
      payload: {
        version: child.version,
        parentId: replacement.id,
        parentVersion: replacement.version,
        currentParentVersion: parent.version - 1,
      },
    });
    expect(staleMove.statusCode).toBe(409);
    expect((await get(child.id)).parentId).toBe(parent.id);
    expect((await get(replacement.id)).relationships.subtasks).toHaveLength(0);
    const reassigned = await app.inject({
      method: "PUT",
      url: `/api/actionables/${child.id}/parent`,
      payload: {
        version: child.version,
        parentId: replacement.id,
        parentVersion: replacement.version,
        currentParentVersion: parent.version,
      },
    });
    expect(reassigned.statusCode).toBe(200);
    child = reassigned.json().item;
    replacement = await get(replacement.id);
    expect(child.relationships.parent.parent.id).toBe(replacement.id);
    expect((await get(grandchild.id)).parentId).toBe(child.id);
    expect((await get(greatGrandchild.id)).parentId).toBe(grandchild.id);
    expect(
      child.activity.some(
        (event: { type: string }) => event.type === "hierarchy-reassigned",
      ),
    ).toBe(true);

    const staleDetach = await app.inject({
      method: "DELETE",
      url: `/api/actionables/${child.id}/parent`,
      payload: {
        version: child.version - 1,
        parentVersion: replacement.version,
      },
    });
    expect(staleDetach.statusCode).toBe(409);
    expect(staleDetach.json().current.version).toBe(child.version);

    const detached = await app.inject({
      method: "DELETE",
      url: `/api/actionables/${child.id}/parent`,
      payload: { version: child.version, parentVersion: replacement.version },
    });
    expect(detached.statusCode).toBe(200);
    expect(detached.json().item.relationships.parent).toBeNull();
    expect((await get(grandchild.id)).parentId).toBe(child.id);
    expect((await get(greatGrandchild.id)).parentId).toBe(grandchild.id);
    expect(
      await prisma.hierarchyRelationship.count({
        where: { childId: child.recordId, detachedAt: { not: null } },
      }),
    ).toBe(2);
    expect(
      detached
        .json()
        .item.activity.some(
          (event: { type: string }) => event.type === "hierarchy-detached",
        ),
    ).toBe(true);
  });
});

describe("dependency relationships", () => {
  it("supports cross-scope edges, derived state, waiver/restore/removal, and cycle rejection", async () => {
    let dependent = await create("Dependent");
    let prerequisite = await create("Cross-scope prerequisite", otherScope);
    let third = await create("Third");

    const added = await app.inject({
      method: "POST",
      url: `/api/actionables/${dependent.id}/dependencies`,
      payload: {
        version: dependent.version,
        prerequisiteId: prerequisite.id,
        prerequisiteVersion: prerequisite.version,
      },
    });
    expect(added.statusCode).toBe(200);
    dependent = added.json().item;
    prerequisite = await get(prerequisite.id);
    const edge = dependent.relationships.blockedBy[0];
    expect(edge.state).toBe("unresolved");
    expect(dependent).toMatchObject({
      isDependencyBlocked: true,
      unresolvedDependencyCount: 1,
    });

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/actionables/${dependent.id}/dependencies`,
      payload: {
        version: dependent.version,
        prerequisiteId: prerequisite.id,
        prerequisiteVersion: prerequisite.version,
      },
    });
    expect(duplicate.json().code).toBe("DUPLICATE_DEPENDENCY");

    const waived = await app.inject({
      method: "POST",
      url: `/api/actionables/${dependent.id}/dependencies/${edge.id}/waive`,
      payload: {
        version: dependent.version,
        prerequisiteVersion: prerequisite.version,
        reason: "Proceeding under an explicitly accepted risk",
      },
    });
    expect(waived.statusCode).toBe(200);
    dependent = waived.json().item;
    prerequisite = await get(prerequisite.id);
    expect(dependent.relationships.blockedBy[0]).toMatchObject({
      state: "waived",
      isSatisfied: true,
    });
    expect(dependent.isDependencyBlocked).toBe(false);

    const restored = await app.inject({
      method: "POST",
      url: `/api/actionables/${dependent.id}/dependencies/${edge.id}/restore`,
      payload: {
        version: dependent.version,
        prerequisiteVersion: prerequisite.version,
      },
    });
    expect(restored.statusCode).toBe(200);
    dependent = restored.json().item;
    prerequisite = await get(prerequisite.id);
    expect(dependent.relationships.blockedBy[0].state).toBe("unresolved");

    const thirdDependsOnDependent = await app.inject({
      method: "POST",
      url: `/api/actionables/${third.id}/dependencies`,
      payload: {
        version: third.version,
        prerequisiteId: dependent.id,
        prerequisiteVersion: dependent.version,
      },
    });
    expect(thirdDependsOnDependent.statusCode).toBe(200);
    third = thirdDependsOnDependent.json().item;
    dependent = await get(dependent.id);

    const transitiveCycle = await app.inject({
      method: "POST",
      url: `/api/actionables/${prerequisite.id}/dependencies`,
      payload: {
        version: prerequisite.version,
        prerequisiteId: third.id,
        prerequisiteVersion: third.version,
      },
    });
    expect(transitiveCycle.statusCode).toBe(422);
    expect(transitiveCycle.json().code).toBe("DEPENDENCY_CYCLE");

    prerequisite = await get(prerequisite.id);
    prerequisite = await move(prerequisite, "Researching");
    prerequisite = await move(prerequisite, "Ready");
    prerequisite = await move(prerequisite, "In progress");
    prerequisite = await move(prerequisite, "Done", {
      completionOverrideReason:
        "Verified externally for this relationship test",
    });
    dependent = await get(dependent.id);
    expect(dependent.relationships.blockedBy[0].state).toBe("satisfied");
    expect(dependent.isDependencyBlocked).toBe(false);

    dependent = await get(dependent.id);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/actionables/${dependent.id}/dependencies/${edge.id}`,
      payload: {
        version: dependent.version,
        prerequisiteVersion: prerequisite.version,
        reason: "The execution ordering is no longer required",
      },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().item.relationships.blockedBy).toHaveLength(0);
    expect(
      removed
        .json()
        .item.activity.some(
          (event: { type: string }) => event.type === "dependency-removed",
        ),
    ).toBe(true);
  });

  it("treats Dismissed as unresolved and prevents concurrent opposite edges from committing a cycle", async () => {
    let dependent = await create("Dismissed prerequisite dependent");
    let dismissed = await create("Dismissed prerequisite");
    dismissed = await move(dismissed, "Dismissed", {
      reason: "This work is no longer intended",
    });
    const edge = await app.inject({
      method: "POST",
      url: `/api/actionables/${dependent.id}/dependencies`,
      payload: {
        version: dependent.version,
        prerequisiteId: dismissed.id,
        prerequisiteVersion: dismissed.version,
      },
    });
    expect(edge.statusCode).toBe(200);
    dependent = edge.json().item;
    expect(dependent.relationships.blockedBy[0]).toMatchObject({
      state: "dismissed-prerequisite",
      isSatisfied: false,
    });
    expect(dependent.isDependencyBlocked).toBe(true);

    const left = await create("Concurrent left");
    const right = await create("Concurrent right");
    const [leftResult, rightResult] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/actionables/${left.id}/dependencies`,
        payload: {
          version: left.version,
          prerequisiteId: right.id,
          prerequisiteVersion: right.version,
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/actionables/${right.id}/dependencies`,
        payload: {
          version: right.version,
          prerequisiteId: left.id,
          prerequisiteVersion: left.version,
        },
      }),
    ]);
    expect(
      [leftResult.statusCode, rightResult.statusCode].filter(
        (status) => status === 200,
      ),
    ).toHaveLength(1);
    expect(
      [leftResult.statusCode, rightResult.statusCode].every(
        (status) => status === 200 || status === 409 || status === 422,
      ),
    ).toBe(true);
    const committed = await prisma.dependencyRelationship.count({
      where: {
        removedAt: null,
        OR: [
          { dependentId: left.recordId, prerequisiteId: right.recordId },
          { dependentId: right.recordId, prerequisiteId: left.recordId },
        ],
      },
    });
    expect(committed).toBe(1);
  });
});

describe("parent lifecycle integration", () => {
  async function attach(childId: number, parentId: number) {
    const child = await get(childId);
    const parent = await get(parentId);
    const response = await app.inject({
      method: "PUT",
      url: `/api/actionables/${childId}/parent`,
      payload: {
        version: child.version,
        parentId,
        parentVersion: parent.version,
        currentParentVersion: child.relationships.parent?.parent.version,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().item;
  }

  async function validate(id: number) {
    const item = await get(id);
    const response = await app.inject({
      method: "POST",
      url: `/api/actionables/${id}/validation-records`,
      payload: {
        version: item.version,
        type: "Automated test",
        outcome: "Passed",
        evidence: "Nested lifecycle test fixture evidence",
        notes: "",
        origin: "user",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().item;
  }

  async function finish(id: number) {
    let item = await get(id);
    if (item.status === "Inbox") item = await move(item, "Researching");
    if (item.status === "Researching") item = await move(item, "Ready");
    if (item.status === "Ready") item = await move(item, "In progress");
    item = await validate(id);
    return move(item, "Done");
  }

  it("checks work beneath terminal intermediates and reopens every completed ancestor with fresh validation required", async () => {
    const root = await create("Deep lifecycle root");
    const child = await create("Dismissed intermediate");
    const grandchild = await create("Completed intermediate");
    const leaf = await create("Deep lifecycle leaf");
    await attach(child.id, root.id);
    await attach(grandchild.id, child.id);
    await attach(leaf.id, grandchild.id);
    await move(await get(child.id), "Dismissed", {
      reason: "Coordination delegated to its descendant",
    });
    await move(await get(grandchild.id), "Dismissed", {
      reason: "Coordination delegated to its descendant",
    });
    let current = await move(await get(root.id), "Researching");
    current = await move(current, "Ready");
    current = await move(current, "In progress");
    const premature = await app.inject({
      method: "POST",
      url: `/api/actionables/${root.id}/status-transitions`,
      payload: {
        version: current.version,
        status: "Done",
        completionOverrideReason: "Cannot skip descendant work",
        origin: "user",
      },
    });
    expect(premature.json().code).toBe("INCOMPLETE_SUBTASKS");
    expect(premature.json().errors.children).toEqual([
      `${leaf.id}: ${leaf.title} (Inbox)`,
    ]);
    const editedCompletion = await app.inject({
      method: "PATCH",
      url: `/api/actionables/${root.id}`,
      payload: {
        ...body(root.title),
        version: current.version,
        status: "Done",
      },
    });
    expect(editedCompletion.json().code).toBe("INCOMPLETE_SUBTASKS");
    await finish(leaf.id);
    await move(await get(grandchild.id), "Ready", {
      reason: "Resume coordination validation",
    });
    await finish(grandchild.id);
    const completedRoot = await finish(root.id);
    await move(await get(leaf.id), "Ready", {
      reason: "Deep regression requires follow-up",
    });
    for (const id of [root.id, grandchild.id]) {
      const reopened = await get(id);
      expect(reopened.status).toBe("Ready");
      expect(
        reopened.activity.filter(
          (event: { type: string }) => event.type === "parent-auto-reopened",
        ),
      ).toEqual([
        expect.objectContaining({
          context: expect.objectContaining({
            childOrdinal: String(leaf.id),
            reason: "Deep regression requires follow-up",
            origin: "child-reopen",
          }),
        }),
      ]);
      expect(reopened.statusHistory[0]).toMatchObject({
        previousStatus: "Done",
        newStatus: "Ready",
        origin: "child-reopen",
      });
    }
    expect((await get(child.id)).status).toBe("Dismissed");
    expect((await get(root.id)).childCompletion).toEqual({
      terminal: 1,
      total: 3,
    });
    const stale = await app.inject({
      method: "POST",
      url: `/api/actionables/${root.id}/status-transitions`,
      payload: {
        version: completedRoot.version,
        status: "In progress",
        origin: "user",
      },
    });
    expect(stale.json().code).toBe("VERSION_CONFLICT");
    await finish(leaf.id);
    await finish(grandchild.id);
    current = await move(await get(root.id), "In progress");
    const missingValidation = await app.inject({
      method: "POST",
      url: `/api/actionables/${root.id}/status-transitions`,
      payload: { version: current.version, status: "Done", origin: "user" },
    });
    expect(missingValidation.json().code).toBe("VALIDATION_REQUIRED");
    expect((await finish(root.id)).childCompletion).toEqual({
      terminal: 3,
      total: 3,
    });
  });

  it.each(["create", "breakdown", "move", "terminal move"])(
    "keeps ancestors consistent after %s and detach",
    async (operation) => {
      const root = await create(`Ancestor ${operation} root`);
      const child = await create(`Ancestor ${operation} child`);
      const grandchild = await create(`Ancestor ${operation} grandchild`);
      await attach(child.id, root.id);
      await attach(grandchild.id, child.id);
      await finish(grandchild.id);
      await finish(child.id);
      await finish(root.id);
      const parent = await get(grandchild.id);
      let attachedId: number;
      if (operation === "create" || operation === "breakdown") {
        const path = operation === "create" ? "subtasks" : "task-breakdowns";
        const payload =
          operation === "create"
            ? { version: parent.version, title: "New deep work" }
            : { version: parent.version, template: "research" };
        const response = await app.inject({
          method: "POST",
          url: `/api/actionables/${parent.id}/${path}`,
          payload,
        });
        expect(response.statusCode, response.body).toBe(200);
        attachedId = response.json().item.relationships.subtasks[0].child.id;
      } else {
        const subtree = await create(`Moved subtree ${operation}`);
        if (operation === "move") {
          const leaf = await create("Open beneath dismissed subtree");
          await attach(leaf.id, subtree.id);
        }
        await move(await get(subtree.id), "Dismissed", {
          reason: "Retain work in descendants",
        });
        await attach(subtree.id, parent.id);
        attachedId = subtree.id;
      }
      const expected = operation === "terminal move" ? "Done" : "Ready";
      for (const id of [root.id, child.id, grandchild.id]) {
        const saved = await get(id);
        expect(saved.status).toBe(expected);
        expect(
          saved.activity.filter(
            (event: { type: string }) => event.type === "parent-auto-reopened",
          ),
        ).toHaveLength(expected === "Done" ? 0 : 1);
      }
      const attached = await get(attachedId);
      const detached = await app.inject({
        method: "DELETE",
        url: `/api/actionables/${attachedId}/parent`,
        payload: {
          version: attached.version,
          parentVersion: (await get(grandchild.id)).version,
        },
      });
      expect(detached.statusCode, detached.body).toBe(200);
      expect((await get(root.id)).status).toBe(expected);
      const remaining = operation === "breakdown" ? 4 : 2;
      expect((await get(root.id)).directTaskProgress.total).toBe(remaining);
      expect(
        detached
          .json()
          .item.activity.some(
            (event: { type: string }) => event.type === "hierarchy-detached",
          ),
      ).toBe(true);
      if (operation === "move")
        expect(detached.json().item.directTaskProgress).toMatchObject({
          total: 1,
          open: 1,
        });
    },
  );

  it("gates parent completion and transactionally reopens only a Done parent when a child reopens", async () => {
    let parent = await create("Lifecycle parent");
    let child = await create("Lifecycle child");
    const attached = await app.inject({
      method: "PUT",
      url: `/api/actionables/${child.id}/parent`,
      payload: {
        version: child.version,
        parentId: parent.id,
        parentVersion: parent.version,
      },
    });
    child = attached.json().item;
    parent = await get(parent.id);
    parent = await move(parent, "Researching");
    parent = await move(parent, "Ready");
    parent = await move(parent, "In progress");

    const premature = await app.inject({
      method: "POST",
      url: `/api/actionables/${parent.id}/status-transitions`,
      payload: {
        version: parent.version,
        status: "Done",
        completionOverrideReason: "Parent work is otherwise verified",
        origin: "user",
      },
    });
    expect(premature.json().code).toBe("INCOMPLETE_SUBTASKS");

    child = await move(child, "Researching");
    child = await move(child, "Ready");
    child = await move(child, "In progress");
    child = await move(child, "Done", {
      completionOverrideReason: "Child work verified",
    });
    parent = await get(parent.id);
    parent = await move(parent, "Done", {
      completionOverrideReason: "Parent work verified after its child",
    });

    const reopened = await app.inject({
      method: "POST",
      url: `/api/actionables/${child.id}/status-transitions`,
      payload: {
        version: child.version,
        status: "Ready",
        reason: "A regression requires more work",
        origin: "user",
      },
    });
    expect(reopened.statusCode).toBe(200);
    parent = await get(parent.id);
    expect(parent.status).toBe("Ready");
    expect(
      parent.activity.some(
        (event: { type: string; context: Record<string, string> }) =>
          event.type === "parent-auto-reopened" &&
          event.context.reason === "A regression requires more work",
      ),
    ).toBe(true);
  });
});
