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
  type ScopeOptionsResponse,
  type Status,
  type StatusTransitionRequest,
  type UpdateActionableRequest,
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
} as const;

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

function numberArray(value: Prisma.JsonValue): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((item) => Number(item));
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

function toSummary(row: ActionableRow): ActionableSummary {
  const imported = row.importProvider !== "MANUAL";
  return actionableSummarySchema.parse({
    id: row.sourceOrdinal,
    recordId: row.id,
    externalKey: row.externalKey,
    title: row.title,
    priority: row.priority,
    status: row.status,
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
    blockedBy: numberArray(row.blockedByOrdinalsJson),
    blocks: numberArray(row.blocksOrdinalsJson),
    parentId: row.parentOrdinal ?? undefined,
    childIds: numberArray(row.childOrdinalsJson),
  });
}

function toDetail(row: ActionableRow): ActionableDetail {
  const status = parsePersistedStatus(row.status);
  const imported = row.importProvider !== "MANUAL";
  return actionableDetailSchema.parse({
    ...toSummary(row),
    description: row.description,
    research: stringArray(row.researchJson),
    validation: stringArray(row.validationJson),
    userSources: row.userSourcesJson,
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
      topLevel: rows.filter((row) => row.parentOrdinal === null).length,
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
        include: {
          worktrees: {
            orderBy: { name: "asc" },
          },
        },
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

export async function createActionable(
  prisma: AppPrismaClient,
  input: CreateActionableRequest,
): Promise<ActionableDetail> {
  return prisma.$transaction(async (transaction) => {
    await validateScope(transaction, input);

    const highest = await transaction.actionable.aggregate({
      _max: { sourceOrdinal: true },
    });
    const sourceOrdinal = (highest._max.sourceOrdinal ?? 0) + 1;
    const externalKey = `manual-${randomUUID()}`;

    const created = await transaction.actionable.create({
      data: {
        externalKey,
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
          create: {
            previousStatus: null,
            newStatus: "Inbox",
            origin: "manual-create",
          },
        },
      },
      include: actionableInclude,
    });

    return toDetail(created);
  });
}

function validateTransition(
  previousStatus: Status,
  nextStatus: Status,
  readiness: { finding: string; description: string; validation: string[] },
) {
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

  if (nextStatus === "Ready") {
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
}

async function currentOrNotFound(
  transaction: TransactionClient,
  sourceOrdinal: number,
) {
  const current = await findActionableRow(transaction, sourceOrdinal);
  if (!current) return null;
  return current;
}

export async function updateActionable(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: UpdateActionableRequest,
): Promise<ActionableDetail | null> {
  return prisma.$transaction(async (transaction) => {
    const current = await currentOrNotFound(transaction, sourceOrdinal);
    if (!current) return null;
    if (current.version !== input.version) {
      throw new VersionConflictError(toDetail(current));
    }

    await validateScope(transaction, input);
    const previousStatus = parsePersistedStatus(current.status);
    if (input.status !== previousStatus) {
      validateTransition(previousStatus, input.status, {
        finding: input.finding,
        description: input.description,
        validation: input.validation,
      });
    }

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
        version: { increment: 1 },
      },
    });

    if (updated.count !== 1) {
      const latest = await currentOrNotFound(transaction, sourceOrdinal);
      if (!latest) return null;
      throw new VersionConflictError(toDetail(latest));
    }

    if (input.status !== previousStatus) {
      await transaction.actionableStatusHistory.create({
        data: {
          actionableId: current.id,
          previousStatus,
          newStatus: input.status,
          origin: "user-edit",
        },
      });
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
    if (current.version !== input.version) {
      throw new VersionConflictError(toDetail(current));
    }

    const previousStatus = parsePersistedStatus(current.status);
    validateTransition(previousStatus, input.status, {
      finding: current.finding,
      description: current.description,
      validation: stringArray(current.validationJson),
    });
    const updated = await transaction.actionable.updateMany({
      where: { id: current.id, version: input.version },
      data: {
        status: input.status,
        updatedLabel: "just now",
        version: { increment: 1 },
      },
    });

    if (updated.count !== 1) {
      const latest = await currentOrNotFound(transaction, sourceOrdinal);
      if (!latest) return null;
      throw new VersionConflictError(toDetail(latest));
    }

    await transaction.actionableStatusHistory.create({
      data: {
        actionableId: current.id,
        previousStatus,
        newStatus: input.status,
        origin: input.origin,
      },
    });

    const saved = await currentOrNotFound(transaction, sourceOrdinal);
    return saved ? toDetail(saved) : null;
  });
}
