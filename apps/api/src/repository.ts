import { randomUUID } from "node:crypto";
import {
  actionableDetailSchema,
  actionableSummarySchema,
  actionablesListResponseSchema,
  scopeOptionsResponseSchema,
  type ActionableDetail,
  type ActionableSummary,
  type ActionablesListResponse,
  type CreateActionableRequest,
  type CreateValidationRecordRequest,
  type ScopeOptionsResponse,
  type Status,
  type StatusTransitionRequest,
  type UpdateActionableRequest,
  type UserSourceReferenceInput,
} from "@actionables/contracts";
import type { Prisma } from "./generated/prisma/client.js";
import type { AppPrismaClient } from "./database.js";
import {
  canTransition,
  parsePersistedStatus,
  permittedTransitions,
  transitionExplanation,
} from "./actionable-transitions.js";

const actionableInclude = {
  project: true,
  repository: true,
  worktree: true,
  statusHistory: {
    orderBy: { occurredAt: "desc" as const },
  },
  validationRecords: {
    orderBy: { recordedAt: "asc" as const },
  },
  activityEvents: {
    orderBy: [{ occurredAt: "asc" as const }, { id: "asc" as const }],
  },
  userSources: {
    where: { removedAt: null },
    orderBy: { createdAt: "asc" as const },
  },
  hierarchyAsParent: {
    where: { detachedAt: null },
    orderBy: { createdAt: "asc" as const },
    include: {
      child: { include: { project: true, repository: true, worktree: true } },
    },
  },
  hierarchyAsChild: {
    where: { detachedAt: null },
    include: {
      parent: { include: { project: true, repository: true, worktree: true } },
    },
  },
  dependenciesAsDependent: {
    where: { removedAt: null },
    orderBy: { createdAt: "asc" as const },
    include: {
      prerequisite: { include: { project: true, repository: true, worktree: true } },
    },
  },
  dependenciesAsPrerequisite: {
    where: { removedAt: null },
    orderBy: { createdAt: "asc" as const },
    include: {
      dependent: { include: { project: true, repository: true, worktree: true } },
    },
  },
} satisfies Prisma.ActionableInclude;

type ActionableRow = Prisma.ActionableGetPayload<{
  include: typeof actionableInclude;
}>;
type TransactionClient = Prisma.TransactionClient;

export class DomainValidationError extends Error {
  constructor(
    public readonly code: string,
    public readonly fieldErrors: Record<string, string[]>,
    message: string,
  ) {
    super(message);
  }
}

export class VersionConflictError extends Error {
  constructor(public readonly current: ActionableDetail) {
    super("This actionable changed after editing began.");
  }
}

function stringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function sourceFiles(value: Prisma.JsonValue) {
  return Array.isArray(value) ? value : [];
}

function stringContext(value: Prisma.JsonValue): Record<string, string> {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, String(item ?? "")]),
  );
}

function latestInProgressAt(row: ActionableRow) {
  return row.statusHistory.find((entry) => entry.newStatus === "In progress")?.occurredAt ?? null;
}

function qualifyingValidationIds(row: ActionableRow) {
  const startedAt = latestInProgressAt(row);
  if (!startedAt) return new Set<string>();
  const superseded = new Set(
    row.validationRecords
      .map((record) => record.supersedesId)
      .filter((id): id is string => Boolean(id)),
  );
  return new Set(
    row.validationRecords
      .filter(
        (record) =>
          record.outcome === "Passed" &&
          record.recordedAt >= startedAt &&
          !superseded.has(record.id),
      )
      .map((record) => record.id),
  );
}

function latestQualifyingValidationId(row: ActionableRow) {
  const qualifying = qualifyingValidationIds(row);
  return [...row.validationRecords]
    .reverse()
    .find((record) => qualifying.has(record.id))?.id ?? null;
}

type RelatedRow =
  | ActionableRow
  | ActionableRow["hierarchyAsParent"][number]["child"]
  | ActionableRow["hierarchyAsChild"][number]["parent"]
  | ActionableRow["dependenciesAsDependent"][number]["prerequisite"]
  | ActionableRow["dependenciesAsPrerequisite"][number]["dependent"];

function relatedActionable(row: RelatedRow) {
  return {
    id: row.sourceOrdinal,
    recordId: row.id,
    title: row.title,
    status: parsePersistedStatus(row.status),
    version: row.version,
    scope: {
      projectId: row.project.id,
      projectName: row.project.name,
      repositoryId: row.repository.id,
      repositoryName: row.repository.name,
      worktreeId: row.worktree.id,
      worktreeName: row.worktree.name,
    },
  };
}

function dependencyState(
  relationship: ActionableRow["dependenciesAsDependent"][number],
) {
  const prerequisite = relationship.prerequisite;
  if (relationship.waivedAt) return "waived" as const;
  if (prerequisite.status === "Done") return "satisfied" as const;
  if (prerequisite.status === "Dismissed") return "dismissed-prerequisite" as const;
  return "unresolved" as const;
}

function dependencyDetail(
  relationship: ActionableRow["dependenciesAsDependent"][number],
  dependent: RelatedRow,
) {
  const state = dependencyState(relationship);
  return {
    id: relationship.id,
    dependent: relatedActionable(dependent),
    prerequisite: relatedActionable(relationship.prerequisite),
    state,
    isSatisfied: state === "satisfied" || state === "waived",
    waiverReason: relationship.waiverReason,
    createdAt: relationship.createdAt.toISOString(),
  };
}

function toSummary(row: ActionableRow): ActionableSummary {
  const imported = row.importProvider !== "MANUAL";
  const status = parsePersistedStatus(row.status);
  const unresolvedDependencies = row.dependenciesAsDependent.filter(
    (relationship) =>
      !relationship.waivedAt && relationship.prerequisite.status !== "Done",
  );
  const childIds = row.hierarchyAsParent.map(
    (relationship) => relationship.child.sourceOrdinal,
  );
  const terminalChildren = row.hierarchyAsParent.filter((relationship) =>
    ["Done", "Dismissed"].includes(relationship.child.status),
  ).length;
  return actionableSummarySchema.parse({
    id: row.sourceOrdinal,
    recordId: row.id,
    externalKey: row.externalKey,
    title: row.title,
    priority: row.priority,
    status,
    statusProvenance: imported
      ? {
          kind: "neutral-import",
          note: row.statusProvenance,
          suggestedStatus: row.sourceStatusSuggestion ?? undefined,
        }
      : {
          kind: "user-authored",
          note: row.statusProvenance,
        },
    scope: {
      projectId: row.project.id,
      projectName: row.project.name,
      repositoryId: row.repository.id,
      repositoryName: row.repository.name,
      worktreeId: row.worktree.id,
      worktreeName: row.worktree.name,
    },
    worktree: row.worktree.name,
    effort: row.effort,
    evidenceState: row.evidenceState,
    version: row.version,
    updated: row.updatedLabel,
    finding: row.finding,
    tags: stringArray(row.tagsJson),
    manualBlocker: row.manualBlockerMd,
    isDependencyBlocked: unresolvedDependencies.length > 0,
    isEffectivelyBlocked: status === "Blocked" || unresolvedDependencies.length > 0,
    unresolvedDependencyCount: unresolvedDependencies.length,
    dependencyCount: row.dependenciesAsDependent.length,
    blocksCount: row.dependenciesAsPrerequisite.length,
    blockedBy:
      row.dependenciesAsDependent.length > 0
        ? row.dependenciesAsDependent.map(
            (relationship) => relationship.prerequisite.sourceOrdinal,
          )
        : undefined,
    blocks:
      row.dependenciesAsPrerequisite.length > 0
        ? row.dependenciesAsPrerequisite.map(
            (relationship) => relationship.dependent.sourceOrdinal,
          )
        : undefined,
    parentId: row.hierarchyAsChild[0]?.parent.sourceOrdinal,
    childIds: childIds.length > 0 ? childIds : undefined,
    childCompletion:
      childIds.length > 0
        ? { terminal: terminalChildren, total: childIds.length }
        : undefined,
  });
}

function toDetail(row: ActionableRow): ActionableDetail {
  const status = parsePersistedStatus(row.status);
  const imported = row.importProvider !== "MANUAL";
  const qualifying = qualifyingValidationIds(row);
  return actionableDetailSchema.parse({
    ...toSummary(row),
    description: row.description,
    research: stringArray(row.researchJson),
    validation: stringArray(row.validationJson),
    userSources: row.userSources.map((source) => ({
      id: source.id,
      type: source.type,
      locator: source.locator,
      label: source.label ?? undefined,
      provenance: "user-added",
      createdAt: source.createdAt.toISOString(),
    })),
    immutableSourceEvidence: {
      imported,
      sourceThread: imported ? row.sourceThread : "",
      sourceFiles: imported ? sourceFiles(row.filesJson) : [],
      rawSource: imported ? row.rawFragmentJson : undefined,
      note: imported
        ? "Imported source evidence is read-only. Editing the actionable changes only user-authored fields."
        : "This actionable was created manually and has no imported source evidence.",
    },
    files: sourceFiles(row.filesJson),
    sourceThread: row.sourceThread,
    permittedTransitions: permittedTransitions(status),
    statusHistory: row.statusHistory.map((entry) => ({
      id: entry.id,
      previousStatus: entry.previousStatus,
      newStatus: entry.newStatus,
      origin: entry.origin,
      occurredAt: entry.occurredAt.toISOString(),
    })),
    validationRecords: row.validationRecords.map((record) => ({
      id: record.id,
      type: record.type,
      outcome: record.outcome,
      notes: record.notesMd,
      evidence: record.evidenceMd,
      origin: record.origin,
      recordedAt: record.recordedAt.toISOString(),
      supersedesId: record.supersedesId,
      supersededById:
        row.validationRecords.find((candidate) => candidate.supersedesId === record.id)?.id ?? null,
      qualifiesForCompletion: qualifying.has(record.id),
    })),
    activity: row.activityEvents.map((event) => ({
      id: event.id,
      type: event.type,
      summary: event.summary,
      context: stringContext(event.metadataJson),
      occurredAt: event.occurredAt.toISOString(),
    })),
    completionEligibility: {
      qualifyingValidationRecordId: latestQualifyingValidationId(row),
      policy:
        "A current Passed validation recorded after the latest move into In progress qualifies. Failed, Partial, and superseded records do not.",
    },
    relationships: {
      parent: row.hierarchyAsChild[0]
        ? {
            id: row.hierarchyAsChild[0].id,
            parent: relatedActionable(row.hierarchyAsChild[0].parent),
            child: relatedActionable(row),
            createdAt: row.hierarchyAsChild[0].createdAt.toISOString(),
          }
        : null,
      subtasks: row.hierarchyAsParent.map((relationship) => ({
        id: relationship.id,
        parent: relatedActionable(row),
        child: relatedActionable(relationship.child),
        createdAt: relationship.createdAt.toISOString(),
      })),
      blockedBy: row.dependenciesAsDependent.map((relationship) =>
        dependencyDetail(relationship, row),
      ),
      blocks: row.dependenciesAsPrerequisite.map((relationship) => {
        const state = relationship.waivedAt
          ? "waived"
          : row.status === "Done"
            ? "satisfied"
            : row.status === "Dismissed"
              ? "dismissed-prerequisite"
              : "unresolved";
        return {
          id: relationship.id,
          dependent: relatedActionable(relationship.dependent),
          prerequisite: relatedActionable(row),
          state,
          isSatisfied: state === "satisfied" || state === "waived",
          waiverReason: relationship.waiverReason,
          createdAt: relationship.createdAt.toISOString(),
        };
      }),
    },
  });
}

async function validateScope(
  client: AppPrismaClient | TransactionClient,
  input: Pick<CreateActionableRequest, "projectId" | "repositoryId" | "worktreeId">,
) {
  const [project, repository, worktree] = await Promise.all([
    client.project.findUnique({ where: { id: input.projectId } }),
    client.repository.findUnique({ where: { id: input.repositoryId } }),
    client.worktree.findUnique({ where: { id: input.worktreeId } }),
  ]);

  const errors: Record<string, string[]> = {};
  if (!project) errors.projectId = ["Choose an existing project."];
  if (!repository || repository.projectId !== input.projectId) {
    errors.repositoryId = ["Choose a repository in the selected project."];
  }
  if (
    !worktree ||
    worktree.projectId !== input.projectId ||
    worktree.repositoryId !== input.repositoryId
  ) {
    errors.worktreeId = ["Choose a worktree in the selected repository."];
  }

  if (Object.keys(errors).length > 0) {
    throw new DomainValidationError("INVALID_SCOPE", errors, "The selected scope is invalid.");
  }
}

async function findActionableRow(
  client: AppPrismaClient | TransactionClient,
  sourceOrdinal: number,
) {
  return client.actionable.findUnique({
    where: { sourceOrdinal },
    include: actionableInclude,
  });
}

export async function listActionables(prisma: AppPrismaClient): Promise<ActionablesListResponse> {
  const rows = await prisma.actionable.findMany({
    include: actionableInclude,
    orderBy: { sourceOrdinal: "asc" },
  });
  const first = rows[0];
  if (!first) {
    return actionablesListResponseSchema.parse({
      project: { name: "Actionables" },
      repository: { name: "Repository" },
      worktree: { name: "Worktree" },
      counts: { total: 0, topLevel: 0 },
      items: [],
    });
  }

  return actionablesListResponseSchema.parse({
    project: { name: first.project.name },
    repository: { name: first.repository.name },
    worktree: { name: first.worktree.name },
    counts: {
      total: rows.length,
      topLevel: rows.filter((row) => row.hierarchyAsChild.length === 0).length,
    },
    items: rows.map(toSummary),
  });
}

export async function listScopeOptions(
  prisma: AppPrismaClient,
): Promise<ScopeOptionsResponse> {
  const projects = await prisma.project.findMany({
    orderBy: { name: "asc" },
    include: {
      repositories: {
        orderBy: { name: "asc" },
        include: { worktrees: { orderBy: { name: "asc" } } },
      },
    },
  });

  return scopeOptionsResponseSchema.parse({
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      repositories: project.repositories.map((repository) => ({
        id: repository.id,
        name: repository.name,
        worktrees: repository.worktrees.map((worktree) => ({
          id: worktree.id,
          name: worktree.name,
        })),
      })),
    })),
  });
}

export async function getActionable(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
): Promise<ActionableDetail | null> {
  const row = await findActionableRow(prisma, sourceOrdinal);
  return row ? toDetail(row) : null;
}

function sourceSignature(source: UserSourceReferenceInput) {
  return JSON.stringify([source.type, source.locator.trim(), source.label?.trim() ?? ""]);
}

async function syncUserSources(
  transaction: TransactionClient,
  current: ActionableRow,
  requested: UserSourceReferenceInput[],
) {
  const remaining = [...current.userSources];
  const added: UserSourceReferenceInput[] = [];

  for (const source of requested) {
    const match = remaining.findIndex(
      (candidate) =>
        sourceSignature(candidate as UserSourceReferenceInput) === sourceSignature(source),
    );
    if (match >= 0) remaining.splice(match, 1);
    else added.push(source);
  }

  for (const source of remaining) {
    await transaction.userSourceReference.update({
      where: { id: source.id },
      data: { removedAt: new Date() },
    });
    await transaction.activityEvent.create({
      data: {
        actionableId: current.id,
        type: "source-removed",
        summary: "Removed a user-added source reference",
        metadataJson: inputJson({
          sourceType: source.type,
          label: source.label ?? source.locator,
        }),
      },
    });
  }

  for (const source of added) {
    await transaction.userSourceReference.create({
      data: {
        actionableId: current.id,
        type: source.type,
        locator: source.locator,
        label: source.label || null,
        provenance: "user-added",
      },
    });
    await transaction.activityEvent.create({
      data: {
        actionableId: current.id,
        type: "source-added",
        summary: "Added a user source reference",
        metadataJson: inputJson({
          sourceType: source.type,
          label: source.label || source.locator,
        }),
      },
    });
  }
}

export async function createActionable(
  prisma: AppPrismaClient,
  input: CreateActionableRequest,
): Promise<ActionableDetail> {
  return prisma.$transaction(async (transaction) => {
    await validateScope(transaction, input);
    const highest = await transaction.actionable.aggregate({ _max: { sourceOrdinal: true } });
    const sourceOrdinal = (highest._max.sourceOrdinal ?? 0) + 1;
    const created = await transaction.actionable.create({
      data: {
        externalKey: `manual-${randomUUID()}`,
        sourceOrdinal,
        title: input.title,
        priority: input.priority,
        status: "Inbox",
        statusProvenance: "Created manually with neutral Inbox status.",
        sourceStatusSuggestion: null,
        effort: input.effort,
        evidenceState: input.evidenceState,
        updatedLabel: "just now",
        finding: input.finding,
        description: input.description,
        researchJson: inputJson(input.research),
        validationJson: inputJson(input.validation),
        filesJson: inputJson([]),
        tagsJson: inputJson(input.tags),
        userSourcesJson: inputJson(input.userSources),
        blockedByOrdinalsJson: inputJson([]),
        blocksOrdinalsJson: inputJson([]),
        childOrdinalsJson: inputJson([]),
        importProvider: "MANUAL",
        sourceContainerId: "",
        sourceThread: "",
        contentHash: "",
        rawFragmentJson: inputJson({ kind: "manual" }),
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        worktreeId: input.worktreeId,
        statusHistory: {
          create: { previousStatus: null, newStatus: "Inbox", origin: "manual-create" },
        },
        activityEvents: {
          create: {
            type: "status-transition",
            summary: "Created as Inbox",
            metadataJson: inputJson({ previousStatus: "", newStatus: "Inbox", origin: "manual-create" }),
          },
        },
        userSources: {
          create: input.userSources.map((source) => ({
            type: source.type,
            locator: source.locator,
            label: source.label || null,
            provenance: "user-added",
          })),
        },
      },
    });

    for (const source of input.userSources) {
      await transaction.activityEvent.create({
        data: {
          actionableId: created.id,
          type: "source-added",
          summary: "Added a user source reference",
          metadataJson: inputJson({
            sourceType: source.type,
            label: source.label || source.locator,
          }),
        },
      });
    }

    const row = await findActionableRow(transaction, sourceOrdinal);
    if (!row) throw new Error("Created actionable could not be read.");
    return toDetail(row);
  });
}

type TransitionDecision = {
  reason: string;
  completionMode: "none" | "validated" | "override";
  validationRecordId: string | null;
};

function requiredReason(
  value: string | undefined,
  field: "reason" | "completionOverrideReason",
  message: string,
  meaningful = false,
) {
  const reason = value?.trim() ?? "";
  const isMeaningful = reason.length >= 3 && /[\p{L}\p{N}]/u.test(reason);
  if (!reason || (meaningful && !isMeaningful)) {
    throw new DomainValidationError(
      "REASON_REQUIRED",
      { [field]: [message] },
      message,
    );
  }
  return reason;
}

function validateTransition(
  current: ActionableRow,
  nextStatus: Status,
  readiness: { finding: string; description: string; validation: string[] },
  request: Pick<StatusTransitionRequest, "reason" | "completionOverrideReason">,
): TransitionDecision {
  const previousStatus = parsePersistedStatus(current.status);
  if (!canTransition(previousStatus, nextStatus)) {
    throw new DomainValidationError(
      "INVALID_STATUS_TRANSITION",
      {
        status: [
          `${previousStatus} cannot move to ${nextStatus}. ${transitionExplanation(previousStatus)}`,
        ],
      },
      "The requested status transition is not permitted.",
    );
  }

  if (
    nextStatus === "Ready" &&
    previousStatus !== "Done" &&
    previousStatus !== "Dismissed"
  ) {
    const errors: Record<string, string[]> = {};
    if (!readiness.finding.trim()) {
      errors.finding = ["Add the finding before moving this actionable to Ready."];
    }
    if (!readiness.description.trim()) {
      errors.description = ["Add the intended result before moving this actionable to Ready."];
    }
    if (readiness.validation.length === 0) {
      errors.validation = ["Add at least one validation step before moving to Ready."];
    }
    if (Object.keys(errors).length > 0) {
      errors.status = ["Ready requires a finding, description, and validation plan."];
      throw new DomainValidationError(
        "READY_REQUIREMENTS_NOT_MET",
        errors,
        "This actionable is not ready yet.",
      );
    }
  }

  let reason = "";
  if (nextStatus === "Blocked") {
    reason = requiredReason(
      request.reason,
      "reason",
      "Enter a meaningful blocker note before marking this actionable Blocked.",
      true,
    );
  } else if (nextStatus === "Dismissed") {
    reason = requiredReason(
      request.reason,
      "reason",
      "Enter a dismissal reason. Dismissal is not completion.",
    );
  } else if (
    nextStatus === "Ready" &&
    (previousStatus === "Done" || previousStatus === "Dismissed")
  ) {
    reason = requiredReason(
      request.reason,
      "reason",
      `Enter a reason for reopening this ${previousStatus} actionable.`,
    );
  }

  if (nextStatus !== "Done") {
    return { reason, completionMode: "none", validationRecordId: null };
  }

  const incompleteChildren = current.hierarchyAsParent
    .map((relationship) => relationship.child)
    .filter((child) => child.status !== "Done" && child.status !== "Dismissed");
  if (incompleteChildren.length > 0) {
    throw new DomainValidationError(
      "INCOMPLETE_SUBTASKS",
      {
        status: ["A parent cannot be Done while it has nonterminal subtasks."],
        children: incompleteChildren.map(
          (child) => `${child.sourceOrdinal}: ${child.title} (${child.status})`,
        ),
      },
      "Complete or dismiss every direct subtask before completing this parent.",
    );
  }

  const override = request.completionOverrideReason?.trim() ?? "";
  if (override) {
    return {
      reason: requiredReason(
        override,
        "completionOverrideReason",
        "Enter a completion override reason.",
      ),
      completionMode: "override",
      validationRecordId: null,
    };
  }

  const validationRecordId = latestQualifyingValidationId(current);
  if (!validationRecordId) {
    throw new DomainValidationError(
      "VALIDATION_REQUIRED",
      {
        status: ["Done requires a current Passed validation or a completion override."],
        completionOverrideReason: [
          "Record a Passed validation or provide a nonempty override reason.",
        ],
      },
      "Qualifying validation is required before completion.",
    );
  }
  return { reason: "", completionMode: "validated", validationRecordId };
}

async function writeTransitionHistory(
  transaction: TransactionClient,
  current: ActionableRow,
  nextStatus: Status,
  origin: string,
  decision: TransitionDecision,
  extraContext: Record<string, string> = {},
) {
  const previousStatus = parsePersistedStatus(current.status);
  await transaction.actionableStatusHistory.create({
    data: {
      actionableId: current.id,
      previousStatus,
      newStatus: nextStatus,
      origin,
    },
  });

  let type = "status-transition";
  let summary = `${previousStatus} → ${nextStatus}`;
  const context: Record<string, string> = {
    previousStatus,
    newStatus: nextStatus,
    origin,
    ...extraContext,
  };

  if (nextStatus === "Blocked") {
    type = "manual-blocked";
    summary = "Marked Blocked — manual";
    context.reason = decision.reason;
  } else if (nextStatus === "Dismissed") {
    type = "dismissed";
    summary = "Dismissed — not completed";
    context.reason = decision.reason;
  } else if (
    nextStatus === "Ready" &&
    (previousStatus === "Done" || previousStatus === "Dismissed")
  ) {
    type = "reopened";
    summary = `Reopened ${previousStatus} to Ready`;
    context.reason = decision.reason;
  } else if (decision.completionMode === "validated") {
    type = "completion-validated";
    summary = "Completed with qualifying validation";
    context.validationRecordId = decision.validationRecordId ?? "";
  } else if (decision.completionMode === "override") {
    type = "completion-overridden";
    summary = "Completion override used — not validated";
    context.reason = decision.reason;
  } else if (previousStatus === "Blocked") {
    context.clearedManualBlocker = "true";
  }

  await transaction.activityEvent.create({
    data: {
      actionableId: current.id,
      type,
      summary,
      metadataJson: inputJson(context),
    },
  });
}

async function currentOrNotFound(
  transaction: TransactionClient,
  sourceOrdinal: number,
) {
  return findActionableRow(transaction, sourceOrdinal);
}

export async function updateActionable(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: UpdateActionableRequest,
): Promise<ActionableDetail | null> {
  return prisma.$transaction(async (transaction) => {
    const current = await currentOrNotFound(transaction, sourceOrdinal);
    if (!current) return null;
    if (current.version !== input.version) throw new VersionConflictError(toDetail(current));

    await validateScope(transaction, input);
    const previousStatus = parsePersistedStatus(current.status);
    const decision =
      input.status === previousStatus
        ? null
        : validateTransition(
            current,
            input.status,
            {
              finding: input.finding,
              description: input.description,
              validation: input.validation,
            },
            {},
          );

    const updated = await transaction.actionable.updateMany({
      where: { id: current.id, version: input.version },
      data: {
        title: input.title,
        priority: input.priority,
        status: input.status,
        effort: input.effort,
        evidenceState: input.evidenceState,
        updatedLabel: "just now",
        finding: input.finding,
        description: input.description,
        researchJson: inputJson(input.research),
        validationJson: inputJson(input.validation),
        tagsJson: inputJson(input.tags),
        userSourcesJson: inputJson(input.userSources),
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        worktreeId: input.worktreeId,
        manualBlockerMd:
          previousStatus === "Blocked" && input.status !== "Blocked"
            ? null
            : current.manualBlockerMd,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      const latest = await currentOrNotFound(transaction, sourceOrdinal);
      if (!latest) return null;
      throw new VersionConflictError(toDetail(latest));
    }

    await syncUserSources(transaction, current, input.userSources);
    if (decision) {
      await writeTransitionHistory(transaction, current, input.status, "user-edit", decision);
    }

    const saved = await currentOrNotFound(transaction, sourceOrdinal);
    return saved ? toDetail(saved) : null;
  });
}

export async function transitionActionable(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: StatusTransitionRequest,
): Promise<ActionableDetail | null> {
  return prisma.$transaction(async (transaction) => {
    const current = await currentOrNotFound(transaction, sourceOrdinal);
    if (!current) return null;
    if (current.version !== input.version) throw new VersionConflictError(toDetail(current));

    const previousStatus = parsePersistedStatus(current.status);
    const parentRelationship =
      input.status === "Ready" &&
      (previousStatus === "Done" || previousStatus === "Dismissed") &&
      current.hierarchyAsChild[0]?.parent.status === "Done"
        ? current.hierarchyAsChild[0]
        : null;
    const decision = validateTransition(
      current,
      input.status,
      {
        finding: current.finding,
        description: current.description,
        validation: stringArray(current.validationJson),
      },
      input,
    );
    const updated = await transaction.actionable.updateMany({
      where: { id: current.id, version: input.version },
      data: {
        status: input.status,
        updatedLabel: "just now",
        manualBlockerMd:
          input.status === "Blocked"
            ? decision.reason
            : previousStatus === "Blocked"
              ? null
              : current.manualBlockerMd,
        dismissalReasonMd:
          input.status === "Dismissed" ? decision.reason : current.dismissalReasonMd,
        completionOverrideMd:
          input.status === "Done"
            ? decision.completionMode === "override"
              ? decision.reason
              : null
            : current.completionOverrideMd,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      const latest = await currentOrNotFound(transaction, sourceOrdinal);
      if (!latest) return null;
      throw new VersionConflictError(toDetail(latest));
    }

    await writeTransitionHistory(
      transaction,
      current,
      input.status,
      input.origin,
      decision,
      parentRelationship
        ? {
            hierarchyRelationshipId: parentRelationship.id,
            autoReopenedParentId: parentRelationship.parent.id,
          }
        : {},
    );

    if (parentRelationship) {
      const parent = parentRelationship.parent;
      const parentUpdated = await transaction.actionable.updateMany({
        where: { id: parent.id, version: parent.version, status: "Done" },
        data: {
          status: "Ready",
          updatedLabel: "just now",
          version: { increment: 1 },
        },
      });
      if (parentUpdated.count !== 1) {
        const latestParent = await currentOrNotFound(
          transaction,
          parent.sourceOrdinal,
        );
        if (!latestParent) {
          throw new DomainValidationError(
            "PARENT_NOT_FOUND",
            { parent: ["The parent actionable no longer exists."] },
            "The parent actionable could not be reopened.",
          );
        }
        throw new VersionConflictError(toDetail(latestParent));
      }
      await transaction.actionableStatusHistory.create({
        data: {
          actionableId: parent.id,
          previousStatus: "Done",
          newStatus: "Ready",
          origin: "child-reopen",
        },
      });
      await transaction.activityEvent.create({
        data: {
          actionableId: parent.id,
          type: "parent-auto-reopened",
          summary: "Automatically reopened because a subtask reopened",
          metadataJson: inputJson({
            hierarchyRelationshipId: parentRelationship.id,
            childActionableId: current.id,
            childOrdinal: String(current.sourceOrdinal),
            reason: decision.reason,
            origin: "child-reopen",
          }),
        },
      });
    }
    const saved = await currentOrNotFound(transaction, sourceOrdinal);
    return saved ? toDetail(saved) : null;
  });
}

export async function recordValidation(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: CreateValidationRecordRequest,
): Promise<ActionableDetail | null> {
  return prisma.$transaction(async (transaction) => {
    const current = await currentOrNotFound(transaction, sourceOrdinal);
    if (!current) return null;
    if (current.version !== input.version) throw new VersionConflictError(toDetail(current));
    if (!input.notes.trim() && !input.evidence.trim()) {
      throw new DomainValidationError(
        "VALIDATION_EVIDENCE_REQUIRED",
        {
          notes: ["Add validation notes or evidence."],
          evidence: ["Add validation notes or evidence."],
        },
        "Validation evidence is required.",
      );
    }

    let superseded = null;
    if (input.supersedesId) {
      superseded = current.validationRecords.find(
        (record) => record.id === input.supersedesId,
      );
      if (!superseded) {
        throw new DomainValidationError(
          "INVALID_SUPERSESSION",
          { supersedesId: ["Choose a validation record from this actionable."] },
          "The validation correction target is invalid.",
        );
      }
      if (
        current.validationRecords.some(
          (record) => record.supersedesId === input.supersedesId,
        )
      ) {
        throw new DomainValidationError(
          "ALREADY_SUPERSEDED",
          { supersedesId: ["Correct the latest record in the supersession chain."] },
          "That validation record has already been superseded.",
        );
      }
    }

    const updated = await transaction.actionable.updateMany({
      where: { id: current.id, version: input.version },
      data: { updatedLabel: "just now", version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      const latest = await currentOrNotFound(transaction, sourceOrdinal);
      if (!latest) return null;
      throw new VersionConflictError(toDetail(latest));
    }

    const record = await transaction.validationRecord.create({
      data: {
        actionableId: current.id,
        type: input.type,
        outcome: input.outcome,
        notesMd: input.notes,
        evidenceMd: input.evidence,
        origin: input.origin,
        supersedesId: input.supersedesId ?? null,
      },
    });
    await transaction.activityEvent.create({
      data: {
        actionableId: current.id,
        type: superseded ? "validation-corrected" : "validation-recorded",
        summary: superseded
          ? `Corrected validation result: ${input.outcome}`
          : `Recorded validation result: ${input.outcome}`,
        metadataJson: inputJson({
          validationRecordId: record.id,
          supersedesId: input.supersedesId ?? "",
          validationType: input.type,
          outcome: input.outcome,
          origin: input.origin,
        }),
      },
    });

    const saved = await currentOrNotFound(transaction, sourceOrdinal);
    return saved ? toDetail(saved) : null;
  });
}
