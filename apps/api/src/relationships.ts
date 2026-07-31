import { randomUUID } from "node:crypto";
import type {
  ActionableDetail,
  CreateDependencyRequest,
  CreateSubtaskRequest,
  CreateTaskBreakdownRequest,
  DependencyActionRequest,
  DetachParentRequest,
  Effort,
  Priority,
  SetParentRequest,
  TaskBreakdownTemplate,
} from "@actionables/contracts";
import type { Prisma } from "./generated/prisma/client.js";
import type { AppPrismaClient } from "./database.js";
import {
  DomainValidationError,
  getActionable,
  VersionConflictError,
} from "./repository.js";

type Transaction = Prisma.TransactionClient;
type CreateSubtaskOptions = {
  externalKey?: string;
  origin?: string;
  priority?: Priority;
  description?: string;
  effort?: Effort;
  validation?: string[];
  tags?: string[];
  rawFragment?: Prisma.InputJsonValue;
  statusProvenance?: string;
};

const taskBreakdownTemplates: Record<TaskBreakdownTemplate, readonly string[]> =
  {
    bug: [
      "Reproduce and isolate the bug",
      "Implement the fix",
      "Add regression coverage",
      "Validate affected behavior",
    ],
    feature: [
      "Define acceptance criteria",
      "Implement the feature",
      "Add automated coverage",
      "Validate the end-to-end flow",
    ],
    research: [
      "Define the research question",
      "Gather and assess evidence",
      "Document findings and recommendation",
    ],
    migration: [
      "Inventory affected data and compatibility",
      "Implement the migration and rollback path",
      "Test the migration on representative data",
      "Verify production readiness",
    ],
  };

class StaleRelationshipError extends Error {
  constructor(public readonly ordinal: number) {
    super("A related actionable changed.");
  }
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

async function requireActionable(
  tx: Transaction,
  ordinal: number,
  field: string,
) {
  const actionable = await tx.actionable.findUnique({
    where: { sourceOrdinal: ordinal },
    include: {
      hierarchyAsParent: { where: { detachedAt: null } },
      hierarchyAsChild: { where: { detachedAt: null } },
    },
  });
  if (!actionable) {
    throw new DomainValidationError(
      "RELATED_ACTIONABLE_NOT_FOUND",
      { [field]: ["Choose an existing actionable."] },
      "The related actionable does not exist.",
    );
  }
  return actionable;
}

function requireVersion(
  actionable: { sourceOrdinal: number; version: number },
  expected: number,
) {
  if (actionable.version !== expected) {
    throw new StaleRelationshipError(actionable.sourceOrdinal);
  }
}

async function bump(
  tx: Transaction,
  id: string,
  ordinal: number,
  version: number,
) {
  const updated = await tx.actionable.updateMany({
    where: { id, version },
    data: { version: { increment: 1 }, updatedLabel: "just now" },
  });
  if (updated.count !== 1) throw new StaleRelationshipError(ordinal);
}

async function activity(
  tx: Transaction,
  actionableId: string,
  type: string,
  summary: string,
  context: Record<string, string>,
) {
  await tx.activityEvent.create({
    data: { actionableId, type, summary, metadataJson: json(context) },
  });
}

async function currentDetail(prisma: AppPrismaClient, ordinal: number) {
  const current = await getActionable(prisma, ordinal);
  if (!current) {
    throw new DomainValidationError(
      "ACTIONABLE_NOT_FOUND",
      { id: ["The actionable no longer exists."] },
      "The actionable no longer exists.",
    );
  }
  return current;
}

async function runMutation(
  prisma: AppPrismaClient,
  selectedOrdinal: number,
  operation: (tx: Transaction) => Promise<void>,
): Promise<ActionableDetail> {
  try {
    await prisma.$transaction(operation);
  } catch (error) {
    if (error instanceof StaleRelationshipError) {
      throw new VersionConflictError(
        await currentDetail(prisma, error.ordinal),
      );
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("DEPENDENCY_CYCLE")) {
      throw new DomainValidationError(
        "DEPENDENCY_CYCLE",
        { prerequisiteId: ["This edge would create a dependency cycle."] },
        "A dependency cycle is not allowed.",
      );
    }
    if (
      message.includes("UNIQUE constraint failed") ||
      message.includes("Unique constraint failed")
    ) {
      throw new DomainValidationError(
        "DUPLICATE_RELATIONSHIP",
        { relationship: ["That active relationship already exists."] },
        "The relationship already exists.",
      );
    }
    throw error;
  }
  return currentDetail(prisma, selectedOrdinal);
}

function sameHierarchyScope(
  first: { projectId: string; repositoryId: string; worktreeId: string },
  second: { projectId: string; repositoryId: string; worktreeId: string },
) {
  return (
    first.projectId === second.projectId &&
    first.repositoryId === second.repositoryId &&
    first.worktreeId === second.worktreeId
  );
}

async function assertNoDependencyCycle(
  tx: Transaction,
  dependentId: string,
  prerequisiteId: string,
) {
  const edges = await tx.dependencyRelationship.findMany({
    where: { removedAt: null },
    select: { dependentId: true, prerequisiteId: true },
    take: 10_001,
  });
  if (edges.length > 10_000) {
    throw new DomainValidationError(
      "DEPENDENCY_GRAPH_LIMIT",
      {
        prerequisiteId: [
          "The dependency graph is too large to validate safely.",
        ],
      },
      "The dependency graph validation limit was reached.",
    );
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const values = outgoing.get(edge.prerequisiteId) ?? [];
    values.push(edge.dependentId);
    outgoing.set(edge.prerequisiteId, values);
  }
  const queue = [dependentId];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === prerequisiteId) {
      throw new DomainValidationError(
        "DEPENDENCY_CYCLE",
        {
          prerequisiteId: [
            "This edge would create a direct or transitive cycle.",
          ],
        },
        "A dependency cycle is not allowed.",
      );
    }
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
}

async function createSubtaskRecord(
  tx: Transaction,
  parent: Awaited<ReturnType<typeof requireActionable>>,
  ordinal: number,
  title: string,
  options: CreateSubtaskOptions,
) {
  const child = await tx.actionable.create({
    data: {
      externalKey: options.externalKey ?? `manual-${randomUUID()}`,
      sourceOrdinal: ordinal,
      title,
      priority: options.priority ?? "Unset",
      status: "Inbox",
      statusProvenance:
        options.statusProvenance ??
        "Created manually as a subtask with neutral Inbox status.",
      effort: options.effort ?? "Unknown",
      evidenceState: "Unclassified",
      updatedLabel: "just now",
      finding: "",
      description: options.description ?? "",
      researchJson: json([]),
      validationJson: json(options.validation ?? []),
      filesJson: json([]),
      tagsJson: json(options.tags ?? []),
      userSourcesJson: json([]),
      blockedByOrdinalsJson: json([]),
      blocksOrdinalsJson: json([]),
      childOrdinalsJson: json([]),
      importProvider: "MANUAL",
      sourceContainerId: "",
      sourceThread: "",
      contentHash: "",
      rawFragmentJson: options.rawFragment ?? json({ kind: "manual-subtask" }),
      projectId: parent.projectId,
      repositoryId: parent.repositoryId,
      worktreeId: parent.worktreeId,
      statusHistory: {
        create: {
          previousStatus: null,
          newStatus: "Inbox",
          origin: options.origin ?? "subtask-create",
        },
      },
      activityEvents: {
        create: {
          type: "status-transition",
          summary: "Created as Inbox subtask",
          metadataJson: json({
            previousStatus: "",
            newStatus: "Inbox",
            origin: options.origin ?? "subtask-create",
          }),
        },
      },
    },
  });
  const relationship = await tx.hierarchyRelationship.create({
    data: {
      parentId: parent.id,
      childId: child.id,
      provenance: options.origin ?? "user",
    },
  });
  const context = {
    hierarchyRelationshipId: relationship.id,
    parentOrdinal: String(parent.sourceOrdinal),
    childOrdinal: String(child.sourceOrdinal),
  };
  await activity(
    tx,
    parent.id,
    "hierarchy-attached",
    `Created subtask ${child.sourceOrdinal}`,
    context,
  );
  await activity(
    tx,
    child.id,
    "hierarchy-attached",
    `Attached to parent ${parent.sourceOrdinal}`,
    context,
  );
}

export async function createSubtask(
  prisma: AppPrismaClient,
  parentOrdinal: number,
  input: CreateSubtaskRequest,
  options: CreateSubtaskOptions = {},
) {
  return runMutation(prisma, parentOrdinal, async (tx) => {
    const parent = await requireActionable(tx, parentOrdinal, "parent");
    requireVersion(parent, input.version);
    if (parent.hierarchyAsChild.length) {
      throw new DomainValidationError(
        "HIERARCHY_DEPTH_EXCEEDED",
        { parent: ["A subtask cannot also be a parent."] },
        "Only one hierarchy level is supported.",
      );
    }
    const highest = await tx.actionable.aggregate({
      _max: { sourceOrdinal: true },
    });
    const ordinal = (highest._max.sourceOrdinal ?? 0) + 1;
    await createSubtaskRecord(tx, parent, ordinal, input.title, options);
    await bump(tx, parent.id, parent.sourceOrdinal, parent.version);
  });
}

export async function createTaskBreakdown(
  prisma: AppPrismaClient,
  parentOrdinal: number,
  input: CreateTaskBreakdownRequest,
) {
  return runMutation(prisma, parentOrdinal, async (tx) => {
    const parent = await requireActionable(tx, parentOrdinal, "parent");
    requireVersion(parent, input.version);
    if (parent.hierarchyAsChild.length) {
      throw new DomainValidationError(
        "HIERARCHY_DEPTH_EXCEEDED",
        { parent: ["A subtask cannot also be a parent."] },
        "Only one hierarchy level is supported.",
      );
    }
    const highest = await tx.actionable.aggregate({
      _max: { sourceOrdinal: true },
    });
    const firstOrdinal = (highest._max.sourceOrdinal ?? 0) + 1;
    const titles = taskBreakdownTemplates[input.template];
    for (const [index, title] of titles.entries()) {
      await createSubtaskRecord(tx, parent, firstOrdinal + index, title, {
        origin: `task-breakdown:${input.template}`,
        rawFragment: json({
          kind: "task-breakdown",
          template: input.template,
        }),
        statusProvenance: `Created from the built-in ${input.template} task breakdown with neutral Inbox status.`,
      });
    }
    await bump(tx, parent.id, parent.sourceOrdinal, parent.version);
    await activity(
      tx,
      parent.id,
      "task-breakdown-created",
      `Created ${input.template} task breakdown`,
      {
        template: input.template,
        subtasksCreated: String(titles.length),
      },
    );
  });
}

export async function setParent(
  prisma: AppPrismaClient,
  childOrdinal: number,
  input: SetParentRequest,
) {
  return runMutation(prisma, childOrdinal, async (tx) => {
    if (childOrdinal === input.parentId) {
      throw new DomainValidationError(
        "SELF_HIERARCHY",
        { parentId: ["An actionable cannot be its own parent."] },
        "Self-parenting is not allowed.",
      );
    }
    const child = await requireActionable(tx, childOrdinal, "child");
    const parent = await requireActionable(tx, input.parentId, "parentId");
    requireVersion(child, input.version);
    requireVersion(parent, input.parentVersion);
    if (!sameHierarchyScope(child, parent)) {
      throw new DomainValidationError(
        "HIERARCHY_SCOPE_MISMATCH",
        {
          parentId: [
            "Parent and child must share project, repository, and worktree.",
          ],
        },
        "Hierarchy cannot cross scopes.",
      );
    }
    if (child.hierarchyAsParent.length || parent.hierarchyAsChild.length) {
      throw new DomainValidationError(
        "HIERARCHY_DEPTH_EXCEEDED",
        {
          parentId: ["This relationship would exceed the one-level hierarchy."],
        },
        "Only one hierarchy level is supported.",
      );
    }
    const existing = await tx.hierarchyRelationship.findFirst({
      where: { childId: child.id, detachedAt: null },
      include: { parent: true },
    });
    if (existing?.parentId === parent.id) {
      throw new DomainValidationError(
        "DUPLICATE_HIERARCHY",
        { parentId: ["That parent is already attached."] },
        "The hierarchy relationship already exists.",
      );
    }
    if (existing) {
      if (!input.currentParentVersion) {
        throw new DomainValidationError(
          "CURRENT_PARENT_VERSION_REQUIRED",
          {
            currentParentVersion: [
              "Provide the current parent version to reassign this child.",
            ],
          },
          "Reassignment requires all affected versions.",
        );
      }
      requireVersion(existing.parent, input.currentParentVersion);
      await tx.hierarchyRelationship.update({
        where: { id: existing.id },
        data: { detachedAt: new Date() },
      });
      await bump(
        tx,
        existing.parent.id,
        existing.parent.sourceOrdinal,
        existing.parent.version,
      );
      await activity(
        tx,
        existing.parent.id,
        "hierarchy-detached",
        `Detached subtask ${child.sourceOrdinal}`,
        {
          hierarchyRelationshipId: existing.id,
          childOrdinal: String(child.sourceOrdinal),
          reason: "reassigned",
        },
      );
    }
    const relationship = await tx.hierarchyRelationship.create({
      data: { parentId: parent.id, childId: child.id },
    });
    await bump(tx, child.id, child.sourceOrdinal, child.version);
    await bump(tx, parent.id, parent.sourceOrdinal, parent.version);
    const context = {
      hierarchyRelationshipId: relationship.id,
      parentOrdinal: String(parent.sourceOrdinal),
      childOrdinal: String(child.sourceOrdinal),
      previousParentOrdinal: existing
        ? String(existing.parent.sourceOrdinal)
        : "",
    };
    await activity(
      tx,
      child.id,
      existing ? "hierarchy-reassigned" : "hierarchy-attached",
      existing
        ? `Reassigned to parent ${parent.sourceOrdinal}`
        : `Attached to parent ${parent.sourceOrdinal}`,
      context,
    );
    await activity(
      tx,
      parent.id,
      "hierarchy-attached",
      `Attached subtask ${child.sourceOrdinal}`,
      context,
    );
  });
}

export async function detachParent(
  prisma: AppPrismaClient,
  childOrdinal: number,
  input: DetachParentRequest,
) {
  return runMutation(prisma, childOrdinal, async (tx) => {
    const child = await requireActionable(tx, childOrdinal, "child");
    requireVersion(child, input.version);
    const relationship = await tx.hierarchyRelationship.findFirst({
      where: { childId: child.id, detachedAt: null },
      include: { parent: true },
    });
    if (!relationship) {
      throw new DomainValidationError(
        "PARENT_NOT_ATTACHED",
        { parent: ["This actionable has no active parent."] },
        "There is no parent to detach.",
      );
    }
    requireVersion(relationship.parent, input.parentVersion);
    await tx.hierarchyRelationship.update({
      where: { id: relationship.id },
      data: { detachedAt: new Date() },
    });
    await bump(tx, child.id, child.sourceOrdinal, child.version);
    await bump(
      tx,
      relationship.parent.id,
      relationship.parent.sourceOrdinal,
      relationship.parent.version,
    );
    const context = {
      hierarchyRelationshipId: relationship.id,
      parentOrdinal: String(relationship.parent.sourceOrdinal),
      childOrdinal: String(child.sourceOrdinal),
    };
    await activity(
      tx,
      child.id,
      "hierarchy-detached",
      `Detached from parent ${relationship.parent.sourceOrdinal}`,
      context,
    );
    await activity(
      tx,
      relationship.parent.id,
      "hierarchy-detached",
      `Detached subtask ${child.sourceOrdinal}`,
      context,
    );
  });
}

export async function createDependency(
  prisma: AppPrismaClient,
  dependentOrdinal: number,
  input: CreateDependencyRequest,
) {
  return runMutation(prisma, dependentOrdinal, async (tx) => {
    if (dependentOrdinal === input.prerequisiteId) {
      throw new DomainValidationError(
        "SELF_DEPENDENCY",
        { prerequisiteId: ["An actionable cannot depend on itself."] },
        "Self-dependencies are not allowed.",
      );
    }
    const dependent = await requireActionable(
      tx,
      dependentOrdinal,
      "dependent",
    );
    const prerequisite = await requireActionable(
      tx,
      input.prerequisiteId,
      "prerequisiteId",
    );
    requireVersion(dependent, input.version);
    requireVersion(prerequisite, input.prerequisiteVersion);
    const duplicate = await tx.dependencyRelationship.findFirst({
      where: {
        dependentId: dependent.id,
        prerequisiteId: prerequisite.id,
        removedAt: null,
      },
    });
    if (duplicate) {
      throw new DomainValidationError(
        "DUPLICATE_DEPENDENCY",
        { prerequisiteId: ["That active dependency already exists."] },
        "The dependency already exists.",
      );
    }
    await assertNoDependencyCycle(tx, dependent.id, prerequisite.id);
    const relationship = await tx.dependencyRelationship.create({
      data: { dependentId: dependent.id, prerequisiteId: prerequisite.id },
    });
    await bump(tx, dependent.id, dependent.sourceOrdinal, dependent.version);
    await bump(
      tx,
      prerequisite.id,
      prerequisite.sourceOrdinal,
      prerequisite.version,
    );
    const context = {
      dependencyRelationshipId: relationship.id,
      dependentOrdinal: String(dependent.sourceOrdinal),
      prerequisiteOrdinal: String(prerequisite.sourceOrdinal),
    };
    await activity(
      tx,
      dependent.id,
      "dependency-added",
      `Blocked by ${prerequisite.sourceOrdinal}`,
      context,
    );
    await activity(
      tx,
      prerequisite.id,
      "dependency-added",
      `Now blocks ${dependent.sourceOrdinal}`,
      context,
    );
  });
}

async function mutateDependency(
  prisma: AppPrismaClient,
  dependentOrdinal: number,
  relationshipId: string,
  input: DependencyActionRequest,
  action: "remove" | "waive" | "restore",
) {
  return runMutation(prisma, dependentOrdinal, async (tx) => {
    const dependent = await requireActionable(
      tx,
      dependentOrdinal,
      "dependent",
    );
    requireVersion(dependent, input.version);
    const relationship = await tx.dependencyRelationship.findUnique({
      where: { id: relationshipId },
      include: { prerequisite: true },
    });
    if (!relationship || relationship.dependentId !== dependent.id) {
      throw new DomainValidationError(
        "DEPENDENCY_NOT_FOUND",
        { relationship: ["Choose a dependency owned by this actionable."] },
        "The dependency relationship does not exist.",
      );
    }
    requireVersion(relationship.prerequisite, input.prerequisiteVersion);
    const reason = input.reason?.trim() ?? "";
    if ((action === "waive" || action === "remove") && !reason) {
      throw new DomainValidationError(
        "REASON_REQUIRED",
        { reason: [`Enter a reason to ${action} this dependency.`] },
        "A relationship change reason is required.",
      );
    }
    if (action === "remove" && relationship.removedAt) {
      throw new DomainValidationError(
        "DEPENDENCY_REMOVED",
        { relationship: ["This dependency is already removed."] },
        "The dependency is already removed.",
      );
    }
    if (
      action === "waive" &&
      (relationship.removedAt || relationship.waivedAt)
    ) {
      throw new DomainValidationError(
        "DEPENDENCY_NOT_ACTIVE",
        {
          relationship: ["Only an unresolved active dependency can be waived."],
        },
        "The dependency cannot be waived.",
      );
    }
    if (action === "restore") {
      await assertNoDependencyCycle(
        tx,
        dependent.id,
        relationship.prerequisiteId,
      );
    }
    await tx.dependencyRelationship.update({
      where: { id: relationship.id },
      data:
        action === "remove"
          ? { removedAt: new Date() }
          : action === "waive"
            ? { waivedAt: new Date(), waiverReason: reason }
            : { removedAt: null, waivedAt: null, waiverReason: null },
    });
    await bump(tx, dependent.id, dependent.sourceOrdinal, dependent.version);
    await bump(
      tx,
      relationship.prerequisite.id,
      relationship.prerequisite.sourceOrdinal,
      relationship.prerequisite.version,
    );
    const context = {
      dependencyRelationshipId: relationship.id,
      dependentOrdinal: String(dependent.sourceOrdinal),
      prerequisiteOrdinal: String(relationship.prerequisite.sourceOrdinal),
      reason,
    };
    const type =
      action === "remove"
        ? "dependency-removed"
        : action === "waive"
          ? "dependency-waived"
          : "dependency-restored";
    await activity(
      tx,
      dependent.id,
      type,
      `${action === "remove" ? "Removed" : action === "waive" ? "Waived" : "Restored"} dependency on ${relationship.prerequisite.sourceOrdinal}`,
      context,
    );
    await activity(
      tx,
      relationship.prerequisite.id,
      type,
      `Dependency from ${dependent.sourceOrdinal} was ${action === "restore" ? "restored" : `${action}d`}`,
      context,
    );
  });
}

export const removeDependency = (
  prisma: AppPrismaClient,
  ordinal: number,
  relationshipId: string,
  input: DependencyActionRequest,
) => mutateDependency(prisma, ordinal, relationshipId, input, "remove");

export const waiveDependency = (
  prisma: AppPrismaClient,
  ordinal: number,
  relationshipId: string,
  input: DependencyActionRequest,
) => mutateDependency(prisma, ordinal, relationshipId, input, "waive");

export const restoreDependency = (
  prisma: AppPrismaClient,
  ordinal: number,
  relationshipId: string,
  input: DependencyActionRequest,
) => mutateDependency(prisma, ordinal, relationshipId, input, "restore");
