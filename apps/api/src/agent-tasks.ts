import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import {
  agentTaskSummarySchema,
  claimAgentTaskRequestSchema,
  claimAgentTaskResponseSchema,
  createAgentTaskRequestSchema,
  dismissAgentTaskRequestSchema,
  handoffClaimedAgentTaskRequestSchema,
  listAgentTasksRequestSchema,
  listAgentTasksResponseSchema,
  recordClaimedAgentTaskValidationRequestSchema,
  releaseAgentTaskClaimRequestSchema,
  releaseAgentTaskClaimResponseSchema,
  releaseExpiredAgentClaimRequestSchema,
  renewAgentTaskClaimRequestSchema,
  renewAgentTaskClaimResponseSchema,
  sourceFileSchema,
  transitionClaimedAgentTaskRequestSchema,
  updateActionableRequestSchema,
  updateClaimedAgentTaskRequestSchema,
  type ActionableDetail,
  type AgentTaskSummary,
  type ClaimAgentTaskRequest,
  type ClaimAgentTaskResponse,
  type CreateAgentTaskRequest,
  type DismissAgentTaskRequest,
  type HandoffClaimedAgentTaskRequest,
  type ListAgentTasksRequest,
  type ListAgentTasksResponse,
  type RecordClaimedAgentTaskValidationRequest,
  type ReleaseAgentTaskClaimRequest,
  type ReleaseAgentTaskClaimResponse,
  type ReleaseExpiredAgentClaimRequest,
  type RenewAgentTaskClaimRequest,
  type RenewAgentTaskClaimResponse,
  type SourceFile,
  type TransitionClaimedAgentTaskRequest,
  type UpdateClaimedAgentTaskRequest,
} from "@actionables/contracts";
import type { AppPrismaClient } from "./database.js";
import type { Prisma } from "./generated/prisma/client.js";
import {
  createActionable,
  getActionable,
  normalizedLocalPath,
  recordValidation,
  transitionActionable,
  updateActionable,
  VersionConflictError,
} from "./repository.js";
import { createSubtask } from "./relationships.js";

const execFileAsync = promisify(execFile);
const terminalStatuses = ["Done", "Dismissed"];
const defaultAgentTaskLeaseMinutes = 30;
const claimLocks = new Map<string, Promise<void>>();
const agentTaskInclude = {
  project: true,
  repository: true,
  worktree: true,
  agentTaskClaim: true,
  hierarchyAsParent: {
    where: { detachedAt: null },
    include: {
      child: {
        select: { sourceOrdinal: true },
      },
    },
  },
  hierarchyAsChild: {
    where: { detachedAt: null },
    include: {
      parent: {
        select: {
          sourceOrdinal: true,
          status: true,
          archivedAt: true,
        },
      },
    },
  },
  dependenciesAsDependent: {
    where: { removedAt: null },
    include: {
      prerequisite: {
        select: { status: true },
      },
    },
  },
} satisfies Prisma.ActionableInclude;

type AgentTaskRow = Prisma.ActionableGetPayload<{
  include: typeof agentTaskInclude;
}>;
const agentTaskMutationInclude = {
  ...agentTaskInclude,
  userSources: {
    where: { removedAt: null },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.ActionableInclude;
type AgentTaskMutationRow = Prisma.ActionableGetPayload<{
  include: typeof agentTaskMutationInclude;
}>;
type TransactionClient = Prisma.TransactionClient;
export type UpdateClaimedAgentTaskResult = {
  task: ActionableDetail;
  researchAppend?: {
    appended: number;
    duplicatesIgnored: number;
  };
};

export class AgentTaskClaimError extends Error {
  constructor(
    public readonly code:
      | "INVALID_REQUEST"
      | "NOT_FOUND"
      | "ARCHIVED"
      | "TERMINAL"
      | "VERSION_CONFLICT"
      | "ALREADY_CLAIMED"
      | "INVALID_CLAIM_TOKEN"
      | "CLAIM_EXPIRED"
      | "IDEMPOTENCY_CONFLICT"
      | "THREAD_ID_REQUIRED"
      | "CREATOR_THREAD_MISMATCH",
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
    public readonly currentVersion?: number,
  ) {
    super(message);
  }
}

export class ExpiredAgentClaimReleaseConflictError extends Error {
  constructor(
    public readonly code: "CLAIM_ACTIVE" | "CLAIM_NOT_FOUND",
    public readonly current: ActionableDetail,
  ) {
    super(
      code === "CLAIM_ACTIVE"
        ? "This agent claim is still active."
        : "This agent claim no longer exists.",
    );
  }
}

function parseInput<T>(
  schema: {
    safeParse: (value: unknown) =>
      | { success: true; data: T }
      | {
          success: false;
          error: {
            flatten: () => {
              fieldErrors: Record<string, string[] | undefined>;
            };
          };
        };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fieldErrors = Object.fromEntries(
    Object.entries(result.error.flatten().fieldErrors)
      .filter((entry): entry is [string, string[]] => Boolean(entry[1]?.length))
      .map(([field, messages]) => [field, messages]),
  );
  throw new AgentTaskClaimError(
    "INVALID_REQUEST",
    "The agent task request is invalid.",
    fieldErrors,
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(token: string, expectedHash: string) {
  const candidate = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

function leaseExpiry(now: Date, leaseMinutes: number) {
  return new Date(now.getTime() + leaseMinutes * 60_000);
}

async function withClaimLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = claimLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  claimLocks.set(key, current);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (claimLocks.get(key) === current) claimLocks.delete(key);
  }
}

function isArchived(row: AgentTaskRow) {
  return Boolean(
    row.archivedAt ||
    row.project.archivedAt ||
    row.repository.archivedAt ||
    row.worktree.archivedAt,
  );
}

function toAgentTaskSummary(row: AgentTaskRow): AgentTaskSummary {
  const parentId = row.hierarchyAsChild[0]?.parent.sourceOrdinal ?? null;
  const unresolvedDependencyCount = row.dependenciesAsDependent.filter(
    (relationship) =>
      relationship.waivedAt === null &&
      relationship.prerequisite.status !== "Done",
  ).length;
  return agentTaskSummarySchema.parse({
    id: row.sourceOrdinal,
    recordId: row.id,
    workItemId: parentId ?? row.sourceOrdinal,
    parentId,
    childIds: row.hierarchyAsParent.map(
      (relationship) => relationship.child.sourceOrdinal,
    ),
    title: row.title,
    findingExcerpt: truncateExcerpt(row.finding, 300),
    tags: persistedStringArray(row.tagsJson).slice(0, 10),
    priority: row.priority,
    status: row.status,
    effort: row.effort,
    evidenceState: row.evidenceState,
    isEffectivelyBlocked:
      row.status === "Blocked" || unresolvedDependencyCount > 0,
    unresolvedDependencyCount,
    version: row.version,
    scope: {
      projectId: row.project.id,
      projectName: row.project.name,
      repositoryId: row.repository.id,
      repositoryName: row.repository.name,
      worktreeId: row.worktree.id,
      worktreeName: row.worktree.name,
    },
    updatedAt: row.updatedAt.toISOString(),
    claim: row.agentTaskClaim
      ? {
          agentId: row.agentTaskClaim.agentId,
          claimedAt: row.agentTaskClaim.claimedAt.toISOString(),
          renewedAt: row.agentTaskClaim.renewedAt.toISOString(),
          leaseExpiresAt: row.agentTaskClaim.leaseExpiresAt.toISOString(),
        }
      : null,
  });
}

function truncateExcerpt(value: string, max: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 1)}…`;
}

async function findTask(
  prisma: AppPrismaClient | TransactionClient,
  sourceOrdinal: number,
) {
  return prisma.actionable.findUnique({
    where: { sourceOrdinal },
    include: agentTaskInclude,
  });
}

async function findMutationTask(
  prisma: AppPrismaClient | TransactionClient,
  sourceOrdinal: number,
) {
  return prisma.actionable.findUnique({
    where: { sourceOrdinal },
    include: agentTaskMutationInclude,
  });
}

async function requireWorkItem(
  prisma: AppPrismaClient | TransactionClient,
  sourceOrdinal: number,
) {
  const row = await findTask(prisma, sourceOrdinal);
  if (!row) {
    throw new AgentTaskClaimError(
      "NOT_FOUND",
      "The feature or bug work item was not found.",
    );
  }
  if (row.hierarchyAsChild.length > 0) {
    throw new AgentTaskClaimError(
      "INVALID_REQUEST",
      "workItemId must identify a top-level Actionable, not one of its subtasks.",
      {
        workItemId: [
          `Use top-level Actionable ${row.hierarchyAsChild[0]!.parent.sourceOrdinal}.`,
        ],
      },
    );
  }
  if (isArchived(row)) {
    throw new AgentTaskClaimError(
      "ARCHIVED",
      "The feature or bug work item is archived.",
    );
  }
  if (terminalStatuses.includes(row.status)) {
    throw new AgentTaskClaimError(
      "TERMINAL",
      "The feature or bug work item is terminal.",
    );
  }
  return row;
}

function requireTaskInWorkItem(row: AgentTaskRow, workItem: AgentTaskRow) {
  const belongsToWorkItem =
    row.id === workItem.id ||
    row.hierarchyAsChild.some(
      (relationship) => relationship.parentId === workItem.id,
    );
  if (!belongsToWorkItem) {
    throw new AgentTaskClaimError(
      "INVALID_REQUEST",
      "The Actionable does not belong to the requested feature or bug work item.",
      {
        id: [
          `Choose the root or a direct subtask of Actionable ${workItem.sourceOrdinal}.`,
        ],
      },
    );
  }
}

function requireClaimable(
  row: AgentTaskRow | null,
): asserts row is AgentTaskRow {
  if (!row) {
    throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
  }
  if (isArchived(row)) {
    throw new AgentTaskClaimError(
      "ARCHIVED",
      "Archived Actionables cannot be claimed.",
    );
  }
  if (terminalStatuses.includes(row.status)) {
    throw new AgentTaskClaimError(
      "TERMINAL",
      "Terminal Actionables cannot be claimed.",
    );
  }
}

function requireValidClaim(
  row: AgentTaskRow | null,
  claimToken: string,
  now: Date,
) {
  if (!row) {
    throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
  }
  const claim = row.agentTaskClaim;
  if (!claim) {
    throw new AgentTaskClaimError(
      "INVALID_CLAIM_TOKEN",
      "No active claim exists for this Actionable.",
    );
  }
  if (!tokenMatches(claimToken, claim.claimTokenHash)) {
    throw new AgentTaskClaimError(
      "INVALID_CLAIM_TOKEN",
      "The claim token is invalid.",
    );
  }
  if (claim.leaseExpiresAt <= now) return "expired" as const;
  return claim;
}

async function recordObservedExpiry(
  tx: TransactionClient,
  row: AgentTaskRow,
  now: Date,
) {
  const claim = row.agentTaskClaim;
  if (!claim || claim.leaseExpiresAt > now) return;
  await tx.agentTaskClaim.delete({ where: { actionableId: row.id } });
  await tx.activityEvent.create({
    data: {
      actionableId: row.id,
      type: "agent-claim-expired",
      summary: `Agent claim expired for ${claim.agentId}`,
      metadataJson: {
        agentId: claim.agentId,
        leaseExpiredAt: claim.leaseExpiresAt.toISOString(),
      },
      occurredAt: now,
    },
  });
}

type ClaimedMutationCredentials = {
  claimToken: string;
  version: number;
};

async function runClaimedMutation<T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  credentials: ClaimedMutationCredentials,
  now: Date,
  operation: (
    tx: TransactionClient,
    row: AgentTaskMutationRow,
    claim: NonNullable<AgentTaskMutationRow["agentTaskClaim"]>,
  ) => Promise<T>,
): Promise<T> {
  return withClaimLock(String(sourceOrdinal), async () => {
    const result = await prisma.$transaction(async (tx) => {
      const row = await findMutationTask(tx, sourceOrdinal);
      const claim = requireValidClaim(row, credentials.claimToken, now);
      if (claim === "expired") {
        await recordObservedExpiry(tx, row!, now);
        await tx.actionable.update({
          where: { id: row!.id },
          data: {
            version: { increment: 1 },
            updatedLabel: "agent claim expired",
          },
        });
        return { expired: true as const };
      }
      if (isArchived(row!)) {
        throw new AgentTaskClaimError(
          "ARCHIVED",
          "Archived Actionables cannot be changed by an agent.",
        );
      }
      if (terminalStatuses.includes(row!.status)) {
        throw new AgentTaskClaimError(
          "TERMINAL",
          "Terminal Actionables cannot be changed by an agent.",
        );
      }
      if (row!.version !== credentials.version) {
        throw new AgentTaskClaimError(
          "VERSION_CONFLICT",
          "This Actionable changed after it was fetched.",
          undefined,
          row!.version,
        );
      }
      return {
        expired: false as const,
        value: await operation(tx, row!, claim),
      };
    });
    if (result.expired) {
      throw new AgentTaskClaimError(
        "CLAIM_EXPIRED",
        "The claim lease expired and must be reacquired.",
      );
    }
    return result.value;
  });
}

function agentOrigin(agentId: string) {
  return `agent:${agentId}`;
}

function persistedStringArray(value: Prisma.JsonValue) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function creatorThreadId(value: Prisma.JsonValue) {
  return value &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    "creatorThreadId" in value &&
    typeof value.creatorThreadId === "string"
    ? value.creatorThreadId
    : null;
}

function appendUniqueUserSources<
  T extends { type: string; locator: string; label?: string },
>(current: T[], additions: T[]) {
  const key = (source: T) =>
    JSON.stringify([source.type, source.locator, source.label ?? ""]);
  const seen = new Set(current.map(key));
  return [
    ...current,
    ...additions.filter((source) => {
      const sourceKey = key(source);
      if (seen.has(sourceKey)) return false;
      seen.add(sourceKey);
      return true;
    }),
  ];
}

function appendUniqueStrings(current: string[], additions: string[]) {
  const seen = new Set(current);
  const appended = additions.filter((addition) => {
    if (seen.has(addition)) return false;
    seen.add(addition);
    return true;
  });
  return {
    values: [...current, ...appended],
    appended: appended.length,
    duplicatesIgnored: additions.length - appended.length,
  };
}

function persistedSourceFiles(value: Prisma.JsonValue): SourceFile[] {
  const parsed = sourceFileSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function appendUniqueFiles(current: SourceFile[], additions: SourceFile[]) {
  const key = (file: SourceFile) =>
    JSON.stringify([file.path, file.lines ?? "", file.symbol ?? ""]);
  const seen = new Set(current.map(key));
  return [
    ...current,
    ...additions.filter((file) => {
      const fileKey = key(file);
      if (seen.has(fileKey)) return false;
      seen.add(fileKey);
      return true;
    }),
  ];
}

async function renewClaimAfterMutation(
  tx: TransactionClient,
  row: AgentTaskMutationRow,
  now: Date,
) {
  await tx.agentTaskClaim.update({
    where: { actionableId: row.id },
    data: {
      leaseExpiresAt: leaseExpiry(now, defaultAgentTaskLeaseMinutes),
    },
  });
}

async function releaseClaimAfterTerminalTransition(
  tx: TransactionClient,
  row: AgentTaskMutationRow,
  agentId: string,
  status: "Done" | "Dismissed",
  now: Date,
) {
  await tx.agentTaskClaim.delete({ where: { actionableId: row.id } });
  await tx.activityEvent.create({
    data: {
      actionableId: row.id,
      type: "agent-released",
      summary: `Released agent claim after transition to ${status}`,
      metadataJson: {
        agentId,
        origin: agentOrigin(agentId),
        terminalStatus: status,
      },
      occurredAt: now,
    },
  });
}

export async function listAgentTasks(
  prisma: AppPrismaClient,
  input: ListAgentTasksRequest,
  now = new Date(),
): Promise<ListAgentTasksResponse> {
  const request = parseInput(listAgentTasksRequestSchema, input);
  const workItem =
    request.workItemId === undefined
      ? null
      : await requireWorkItem(prisma, request.workItemId);
  const baseWhere = {
    archivedAt: null,
    status: { notIn: terminalStatuses },
    project: { archivedAt: null },
    repository: { archivedAt: null },
    worktree: { archivedAt: null },
    ...(workItem
      ? {
          AND: [
            {
              OR: [
                { id: workItem.id },
                {
                  hierarchyAsChild: {
                    some: {
                      parentId: workItem.id,
                      detachedAt: null,
                    },
                  },
                },
              ],
            },
          ],
        }
      : {}),
  } satisfies Prisma.ActionableWhereInput;
  const where: Prisma.ActionableWhereInput =
    request.view === "mine"
      ? {
          ...baseWhere,
          agentTaskClaim: {
            is: {
              agentId: request.agentId,
              leaseExpiresAt: { gt: now },
            },
          },
        }
      : {
          ...baseWhere,
          status: { notIn: [...terminalStatuses, "Blocked"] },
          dependenciesAsDependent: {
            none: {
              removedAt: null,
              waivedAt: null,
              prerequisite: { status: { not: "Done" } },
            },
          },
          OR: [
            { agentTaskClaim: { is: null } },
            {
              agentTaskClaim: {
                is: { leaseExpiresAt: { lte: now } },
              },
            },
          ],
        };
  const rows = await prisma.actionable.findMany({
    where,
    include: agentTaskInclude,
    orderBy: [
      { priority: "asc" },
      { updatedAt: "desc" },
      { sourceOrdinal: "asc" },
    ],
    take: request.limit,
  });
  return listAgentTasksResponseSchema.parse({
    items: rows.map((row) => {
      const summary = toAgentTaskSummary(row);
      if (
        request.view === "available" &&
        summary.claim &&
        new Date(summary.claim.leaseExpiresAt) <= now
      ) {
        return { ...summary, claim: null };
      }
      return summary;
    }),
  });
}

function agentTaskCreateFingerprint(request: CreateAgentTaskRequest) {
  return hashToken(
    JSON.stringify({
      parentId: request.parentId ?? null,
      workItemId: request.workItemId ?? null,
      projectId: request.projectId ?? null,
      repositoryId: request.repositoryId ?? null,
      worktreeId: request.worktreeId ?? null,
      repositoryPath: request.repositoryPath ?? null,
      ensureScope: request.ensureScope ?? null,
      title: request.title,
      priority: request.priority,
      description: request.description,
      effort: request.effort,
      plannedValidation: request.plannedValidation,
    }),
  );
}

export type AgentTaskScopeProvisioning = {
  ensured: true;
  repositoryPath: string;
  worktreePath: string;
  projectCreated: boolean;
  repositoryCreated: boolean;
  worktreeCreated: boolean;
};

export type CreateAgentTaskResult = {
  task: ActionableDetail;
  scopeProvisioning?: AgentTaskScopeProvisioning;
};

export type AgentTaskCaller = {
  threadId: string;
};

type ResolvedRepositoryPlacement = {
  repositoryPath: string;
  worktreePath: string;
  projectName: string;
  repositoryName: string;
  worktreeName: string;
};

function sameLocalPath(left: string | null, right: string) {
  return (
    left !== null &&
    normalizedLocalPath(left).toLowerCase() ===
      normalizedLocalPath(right).toLowerCase()
  );
}

function invalidRepositoryPath(message: string) {
  return new AgentTaskClaimError("INVALID_REQUEST", message, {
    repositoryPath: [
      "Provide an existing local path inside the Git repository or worktree.",
    ],
  });
}

async function gitPath(path: string, argument: string) {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", path, "rev-parse", "--path-format=absolute", argument],
      { encoding: "utf8", windowsHide: true },
    );
    return String(result.stdout).trim();
  } catch {
    throw invalidRepositoryPath(
      "repositoryPath is not inside an accessible Git repository.",
    );
  }
}

async function resolveRepositoryPlacement(
  requestedPath: string,
): Promise<ResolvedRepositoryPlacement> {
  let localPath: string;
  try {
    const details = await stat(requestedPath);
    if (!details.isDirectory()) {
      throw invalidRepositoryPath("repositoryPath must be a directory.");
    }
    localPath = await realpath(requestedPath);
  } catch (error) {
    if (error instanceof AgentTaskClaimError) throw error;
    throw invalidRepositoryPath("repositoryPath does not exist.");
  }

  const worktreePath = normalizedLocalPath(
    await realpath(await gitPath(localPath, "--show-toplevel")),
  );
  const commonGitDirectory = normalizedLocalPath(
    await realpath(await gitPath(localPath, "--git-common-dir")),
  );
  const repositoryPath = normalizedLocalPath(
    await realpath(
      basename(commonGitDirectory).toLowerCase() === ".git"
        ? dirname(commonGitDirectory)
        : worktreePath,
    ),
  );
  const repositoryName = basename(repositoryPath);
  return {
    repositoryPath,
    worktreePath,
    projectName: repositoryName,
    repositoryName,
    worktreeName: sameLocalPath(worktreePath, repositoryPath)
      ? "Default"
      : basename(worktreePath),
  };
}

async function ensureAgentTaskScope(
  transaction: TransactionClient,
  placement: ResolvedRepositoryPlacement,
) {
  const repositories = await transaction.repository.findMany({
    include: { project: true, worktrees: true },
  });
  const repository = repositories.find(
    (candidate) =>
      sameLocalPath(candidate.localPath, placement.repositoryPath) ||
      candidate.worktrees.some((worktree) =>
        sameLocalPath(worktree.localPath, placement.worktreePath),
      ),
  );

  if (repository) {
    if (repository.archivedAt || repository.project.archivedAt) {
      throw new AgentTaskClaimError(
        "ARCHIVED",
        "The repository scope resolved from repositoryPath is archived.",
        {
          repositoryPath: [
            "Restore the existing project and repository scope before creating a task.",
          ],
        },
      );
    }
    const worktree = repository.worktrees.find((candidate) =>
      sameLocalPath(candidate.localPath, placement.worktreePath),
    );
    if (worktree?.archivedAt) {
      throw new AgentTaskClaimError(
        "ARCHIVED",
        "The worktree scope resolved from repositoryPath is archived.",
        {
          repositoryPath: [
            "Restore the existing worktree scope before creating a task.",
          ],
        },
      );
    }
    if (worktree) {
      return {
        scope: {
          projectId: repository.projectId,
          repositoryId: repository.id,
          worktreeId: worktree.id,
        },
        provisioning: {
          ensured: true as const,
          repositoryPath: placement.repositoryPath,
          worktreePath: placement.worktreePath,
          projectCreated: false,
          repositoryCreated: false,
          worktreeCreated: false,
        },
      };
    }
    const createdWorktree = await transaction.worktree.create({
      data: {
        externalKey: `agent-scope-worktree-${hashToken(
          placement.worktreePath.toLowerCase(),
        )}`,
        name: placement.worktreeName,
        localPath: placement.worktreePath,
        projectId: repository.projectId,
        repositoryId: repository.id,
      },
    });
    return {
      scope: {
        projectId: repository.projectId,
        repositoryId: repository.id,
        worktreeId: createdWorktree.id,
      },
      provisioning: {
        ensured: true as const,
        repositoryPath: placement.repositoryPath,
        worktreePath: placement.worktreePath,
        projectCreated: false,
        repositoryCreated: false,
        worktreeCreated: true,
      },
    };
  }

  const scopeHash = hashToken(placement.repositoryPath.toLowerCase());
  const project = await transaction.project.create({
    data: {
      externalKey: `agent-scope-project-${scopeHash}`,
      name: placement.projectName,
    },
  });
  const createdRepository = await transaction.repository.create({
    data: {
      externalKey: `agent-scope-repository-${scopeHash}`,
      name: placement.repositoryName,
      localPath: placement.repositoryPath,
      projectId: project.id,
    },
  });
  const worktree = await transaction.worktree.create({
    data: {
      externalKey: `agent-scope-worktree-${hashToken(
        placement.worktreePath.toLowerCase(),
      )}`,
      name: placement.worktreeName,
      localPath: placement.worktreePath,
      projectId: project.id,
      repositoryId: createdRepository.id,
    },
  });
  return {
    scope: {
      projectId: project.id,
      repositoryId: createdRepository.id,
      worktreeId: worktree.id,
    },
    provisioning: {
      ensured: true as const,
      repositoryPath: placement.repositoryPath,
      worktreePath: placement.worktreePath,
      projectCreated: true,
      repositoryCreated: true,
      worktreeCreated: true,
    },
  };
}

async function existingCreatedAgentTask(
  prisma: AppPrismaClient,
  externalKey: string,
  parentId: number | undefined,
  fingerprint: string,
  caller: AgentTaskCaller,
) {
  const existing = await prisma.actionable.findUnique({
    where: { externalKey },
    select: {
      sourceOrdinal: true,
      rawFragmentJson: true,
      hierarchyAsChild: {
        where: { detachedAt: null },
        select: { parent: { select: { sourceOrdinal: true } } },
      },
    },
  });
  if (!existing) return null;
  const fragment = existing.rawFragmentJson;
  const savedFingerprint =
    fragment &&
    !Array.isArray(fragment) &&
    typeof fragment === "object" &&
    "idempotencyFingerprint" in fragment
      ? String(fragment.idempotencyFingerprint)
      : "";
  const savedParentId =
    existing.hierarchyAsChild[0]?.parent.sourceOrdinal ?? undefined;
  if (
    savedFingerprint !== fingerprint ||
    savedParentId !== parentId ||
    creatorThreadId(fragment) !== caller.threadId
  ) {
    throw new AgentTaskClaimError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for a different create request.",
      {
        idempotencyKey: [
          "Reuse a key only for an identical retry; use a new UUID for a new task.",
        ],
      },
    );
  }
  const detail = await getActionable(prisma, existing.sourceOrdinal);
  if (!detail) throw new Error("Created agent task could not be read.");
  return detail;
}

export async function createAgentTask(
  prisma: AppPrismaClient,
  input: CreateAgentTaskRequest,
  caller: AgentTaskCaller,
): Promise<CreateAgentTaskResult> {
  const request = parseInput(createAgentTaskRequestSchema, input);
  const externalKey = `agent-task-${hashToken(request.idempotencyKey)}`;
  const fingerprint = agentTaskCreateFingerprint(request);
  // ponytail: one local create lock; move ordinal allocation into the database before supporting multi-process writers.
  return withClaimLock("create", async () => {
    const existing = await existingCreatedAgentTask(
      prisma,
      externalKey,
      request.parentId,
      fingerprint,
      caller,
    );
    if (existing) return { task: existing };

    let scopeProvisioning: AgentTaskScopeProvisioning | undefined;
    if (request.parentId === undefined) {
      const actionableInput = {
        title: request.title,
        priority: request.priority,
        effort: request.effort,
        evidenceState: "Unclassified" as const,
        finding: "",
        description: request.description,
        research: [],
        validation: request.plannedValidation,
        tags: [],
        userSources: [],
      };
      const options = {
        externalKey,
        origin: "agent-task-create",
        rawFragment: {
          kind: "agent-task",
          idempotencyFingerprint: fingerprint,
          creatorThreadId: caller.threadId,
        },
        statusProvenance: "Created by an agent with neutral Inbox status.",
      };
      if (request.ensureScope) {
        const placement = await resolveRepositoryPlacement(
          request.repositoryPath!,
        );
        await prisma.$transaction(async (transaction) => {
          const ensured = await ensureAgentTaskScope(transaction, placement);
          scopeProvisioning = ensured.provisioning;
          await createActionable(
            prisma,
            { ...actionableInput, ...ensured.scope },
            options,
            transaction,
          );
        });
      } else {
        await createActionable(
          prisma,
          {
            ...actionableInput,
            projectId: request.projectId!,
            repositoryId: request.repositoryId!,
            worktreeId: request.worktreeId!,
          },
          options,
        );
      }
    } else {
      const parent = await getActionable(prisma, request.parentId);
      if (!parent) {
        throw new AgentTaskClaimError(
          "NOT_FOUND",
          "The requested parent Actionable was not found.",
          { parentId: ["Choose an existing Actionable."] },
        );
      }
      const workItem = await requireWorkItem(prisma, request.workItemId!);
      if (parent.recordId !== workItem.id) {
        throw new AgentTaskClaimError(
          "INVALID_REQUEST",
          "The requested parent is not the authorized feature or bug work item.",
          {
            parentId: [
              `Choose top-level Actionable ${workItem.sourceOrdinal} as the parent.`,
            ],
          },
        );
      }
      await createSubtask(
        prisma,
        request.parentId,
        {
          version: parent.version,
          title: request.title,
        },
        {
          externalKey,
          origin: "agent-task-create",
          priority: request.priority,
          description: request.description,
          effort: request.effort,
          validation: request.plannedValidation,
          statusProvenance:
            "Created by an agent as a subtask with neutral Inbox status.",
          rawFragment: {
            kind: "agent-task",
            idempotencyFingerprint: fingerprint,
            creatorThreadId: caller.threadId,
          },
        },
      );
    }

    const created = await existingCreatedAgentTask(
      prisma,
      externalKey,
      request.parentId,
      fingerprint,
      caller,
    );
    if (!created) throw new Error("Created agent task could not be read.");
    return { task: created, scopeProvisioning };
  });
}

export async function getClaimedAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ReleaseAgentTaskClaimRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  const request = parseInput(releaseAgentTaskClaimRequestSchema, input);
  const result = await withClaimLock(String(sourceOrdinal), () =>
    prisma.$transaction(async (tx) => {
      const row = await findTask(tx, sourceOrdinal);
      const claim = requireValidClaim(row, request.claimToken, now);
      if (claim === "expired") {
        await recordObservedExpiry(tx, row!, now);
        await tx.actionable.update({
          where: { id: row!.id },
          data: {
            version: { increment: 1 },
            updatedLabel: "agent claim expired",
          },
        });
        return { expired: true as const };
      }
      if (isArchived(row!)) {
        throw new AgentTaskClaimError(
          "ARCHIVED",
          "Archived Actionables cannot be inspected by an agent.",
        );
      }
      if (terminalStatuses.includes(row!.status)) {
        throw new AgentTaskClaimError(
          "TERMINAL",
          "Terminal Actionables cannot be inspected by an agent.",
        );
      }
      return {
        expired: false as const,
        task: await getActionable(tx, sourceOrdinal),
      };
    }),
  );
  if (result.expired) {
    throw new AgentTaskClaimError(
      "CLAIM_EXPIRED",
      "The claim lease expired and must be reacquired.",
    );
  }
  if (!result.task)
    throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
  return result.task;
}

async function updateClaimedAgentTaskResult(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: UpdateClaimedAgentTaskRequest,
  now = new Date(),
): Promise<UpdateClaimedAgentTaskResult> {
  const request = parseInput(updateClaimedAgentTaskRequestSchema, input);
  return runClaimedMutation(
    prisma,
    sourceOrdinal,
    request,
    now,
    async (tx, row, claim) => {
      const currentSources = row.userSources.map((source) => ({
        type: source.type,
        locator: source.locator,
        ...(source.label ? { label: source.label } : {}),
      }));
      const currentResearch = persistedStringArray(row.researchJson);
      const currentPlannedValidation = persistedStringArray(row.validationJson);
      const researchAppend = request.appendResearch
        ? appendUniqueStrings(currentResearch, request.appendResearch)
        : undefined;
      const update = parseInput(updateActionableRequestSchema, {
        version: request.version,
        title: request.title ?? row.title,
        priority: request.priority ?? row.priority,
        effort: request.effort ?? row.effort,
        evidenceState: request.evidenceState ?? row.evidenceState,
        projectId: row.projectId,
        repositoryId: row.repositoryId,
        worktreeId: row.worktreeId,
        status: row.status,
        finding: request.finding ?? row.finding,
        description: request.description ?? row.description,
        research: request.research ?? researchAppend?.values ?? currentResearch,
        validation:
          request.plannedValidation ??
          (request.appendPlannedValidation
            ? [...currentPlannedValidation, ...request.appendPlannedValidation]
            : currentPlannedValidation),
        tags: request.tags ?? persistedStringArray(row.tagsJson),
        userSources:
          request.userSources ??
          (request.addUserSources
            ? appendUniqueUserSources(currentSources, request.addUserSources)
            : currentSources),
      });
      const saved = await updateActionable(prisma, sourceOrdinal, update, tx);
      if (!saved)
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");

      const changedFields = [
        "title",
        "priority",
        "effort",
        "evidenceState",
        "finding",
        "description",
        "research",
        "appendResearch",
        "plannedValidation",
        "appendPlannedValidation",
        "tags",
        "userSources",
        "addUserSources",
      ].filter((field) => request[field as keyof typeof request] !== undefined);
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-updated",
          summary: `Updated by agent ${claim.agentId}`,
          metadataJson: {
            origin: agentOrigin(claim.agentId),
            fields: changedFields.join(","),
          },
          occurredAt: now,
        },
      });
      await renewClaimAfterMutation(tx, row, now);
      return {
        task: saved,
        ...(researchAppend
          ? {
              researchAppend: {
                appended: researchAppend.appended,
                duplicatesIgnored: researchAppend.duplicatesIgnored,
              },
            }
          : {}),
      };
    },
  );
}

export async function updateClaimedAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: UpdateClaimedAgentTaskRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  return (await updateClaimedAgentTaskResult(prisma, sourceOrdinal, input, now))
    .task;
}

export function updateClaimedAgentTaskWithReceipt(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: UpdateClaimedAgentTaskRequest,
  now = new Date(),
) {
  return updateClaimedAgentTaskResult(prisma, sourceOrdinal, input, now);
}

export async function transitionClaimedAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: TransitionClaimedAgentTaskRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  const request = parseInput(transitionClaimedAgentTaskRequestSchema, input);
  return runClaimedMutation(
    prisma,
    sourceOrdinal,
    request,
    now,
    async (tx, row, claim) => {
      const saved = await transitionActionable(
        prisma,
        sourceOrdinal,
        {
          version: request.version,
          status: request.status,
          reason: request.reason,
          origin: agentOrigin(claim.agentId),
        },
        tx,
      );
      if (!saved)
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");

      if (request.status === "Done" || request.status === "Dismissed") {
        await releaseClaimAfterTerminalTransition(
          tx,
          row,
          claim.agentId,
          request.status,
          now,
        );
      } else {
        await renewClaimAfterMutation(tx, row, now);
      }
      return saved;
    },
  );
}

export async function dismissAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: DismissAgentTaskRequest,
  caller: AgentTaskCaller,
  now = new Date(),
): Promise<ActionableDetail> {
  const request = parseInput(dismissAgentTaskRequestSchema, input);
  return withClaimLock(String(sourceOrdinal), () =>
    prisma.$transaction(async (tx) => {
      const row = await findTask(tx, sourceOrdinal);
      requireClaimable(row);
      if (creatorThreadId(row.rawFragmentJson) !== caller.threadId) {
        throw new AgentTaskClaimError(
          "CREATOR_THREAD_MISMATCH",
          "Only the Codex thread that created this Actionable can dismiss it without a claim.",
        );
      }
      if (row.agentTaskClaim && row.agentTaskClaim.leaseExpiresAt > now) {
        throw new AgentTaskClaimError(
          "ALREADY_CLAIMED",
          "This Actionable has an active claim.",
          undefined,
          row.version,
        );
      }

      let version = row.version;
      if (row.agentTaskClaim) {
        await recordObservedExpiry(tx, row, now);
        await tx.actionable.update({
          where: { id: row.id },
          data: {
            version: { increment: 1 },
            updatedLabel: "agent claim expired",
          },
        });
        version += 1;
      }

      const saved = await transitionActionable(
        prisma,
        sourceOrdinal,
        {
          version,
          status: "Dismissed",
          reason: request.reason,
          origin: agentOrigin(`codex:${caller.threadId}`),
        },
        tx,
      );
      if (!saved)
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      return saved;
    }),
  );
}

export async function recordClaimedAgentTaskValidation(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RecordClaimedAgentTaskValidationRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  const request = parseInput(
    recordClaimedAgentTaskValidationRequestSchema,
    input,
  );
  return runClaimedMutation(
    prisma,
    sourceOrdinal,
    request,
    now,
    async (tx, row, claim) => {
      const saved = await recordValidation(
        prisma,
        sourceOrdinal,
        {
          version: request.version,
          type: request.type,
          outcome: request.outcome,
          notes: request.notes,
          evidence: request.evidence,
          origin: agentOrigin(claim.agentId),
          supersedesId: request.supersedesId,
        },
        tx,
      );
      if (!saved)
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      await renewClaimAfterMutation(tx, row, now);
      return saved;
    },
  );
}

export async function handoffClaimedAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: HandoffClaimedAgentTaskRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  const request = parseInput(handoffClaimedAgentTaskRequestSchema, input);
  return runClaimedMutation(
    prisma,
    sourceOrdinal,
    request,
    now,
    async (tx, row, claim) => {
      const currentResearch = persistedStringArray(row.researchJson);
      const currentPlannedValidation = persistedStringArray(row.validationJson);
      const research = request.appendResearch
        ? appendUniqueStrings(currentResearch, request.appendResearch).values
        : currentResearch;
      const plannedValidation = request.appendPlannedValidation
        ? appendUniqueStrings(
            currentPlannedValidation,
            request.appendPlannedValidation,
          ).values
        : currentPlannedValidation;
      const files = request.addFiles
        ? appendUniqueFiles(
            persistedSourceFiles(row.filesJson),
            request.addFiles,
          )
        : persistedSourceFiles(row.filesJson);
      const contentFields = [
        "finding",
        "addFiles",
        "appendResearch",
        "appendPlannedValidation",
      ].filter((field) => request[field as keyof typeof request] !== undefined);
      let version = request.version;

      if (contentFields.length > 0) {
        const update = parseInput(updateActionableRequestSchema, {
          version,
          title: row.title,
          priority: row.priority,
          effort: row.effort,
          evidenceState: row.evidenceState,
          projectId: row.projectId,
          repositoryId: row.repositoryId,
          worktreeId: row.worktreeId,
          status: row.status,
          finding: request.finding ?? row.finding,
          description: row.description,
          research,
          validation: plannedValidation,
          tags: persistedStringArray(row.tagsJson),
          userSources: row.userSources.map((source) => ({
            type: source.type,
            locator: source.locator,
            ...(source.label ? { label: source.label } : {}),
          })),
        });
        const saved = await updateActionable(prisma, sourceOrdinal, update, tx);
        if (!saved)
          throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
        version = saved.version;

        if (request.addFiles) {
          await tx.actionable.update({
            where: { id: row.id },
            data: { filesJson: files as Prisma.InputJsonValue },
          });
        }
        await tx.activityEvent.create({
          data: {
            actionableId: row.id,
            type: "agent-updated",
            summary: `Updated by agent ${claim.agentId} during handoff`,
            metadataJson: {
              origin: agentOrigin(claim.agentId),
              fields: contentFields.join(","),
              operation: "handoff",
            },
            occurredAt: now,
          },
        });
      }

      if (request.validation) {
        const saved = await recordValidation(
          prisma,
          sourceOrdinal,
          {
            version,
            ...request.validation,
            origin: agentOrigin(claim.agentId),
          },
          tx,
        );
        if (!saved)
          throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
        version = saved.version;
      }

      await tx.agentTaskClaim.delete({ where: { actionableId: row.id } });
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-released",
          summary: `Released by agent ${claim.agentId} after atomic handoff`,
          metadataJson: {
            agentId: claim.agentId,
            origin: agentOrigin(claim.agentId),
            operation: "handoff",
            version: String(version),
          },
          occurredAt: now,
        },
      });
      const handedOff = await getActionable(tx, sourceOrdinal);
      if (!handedOff)
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      return handedOff;
    },
  );
}

export function claimAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ClaimAgentTaskRequest,
  now = new Date(),
): Promise<ClaimAgentTaskResponse> {
  return withClaimLock(String(sourceOrdinal), () =>
    claimAgentTaskUnlocked(prisma, sourceOrdinal, input, now),
  );
}

async function claimAgentTaskUnlocked(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ClaimAgentTaskRequest,
  now: Date,
): Promise<ClaimAgentTaskResponse> {
  const request = parseInput(claimAgentTaskRequestSchema, input);
  const claimToken = randomBytes(32).toString("base64url");
  const claimTokenHash = hashToken(claimToken);
  const leaseExpiresAt = leaseExpiry(now, request.leaseMinutes);

  try {
    const task = await prisma.$transaction(async (tx) => {
      const row = await findTask(tx, sourceOrdinal);
      requireClaimable(row);
      const workItem = await requireWorkItem(tx, request.workItemId);
      requireTaskInWorkItem(row, workItem);
      if (
        row.agentTaskClaim?.leaseExpiresAt &&
        row.agentTaskClaim.leaseExpiresAt > now
      ) {
        throw new AgentTaskClaimError(
          "ALREADY_CLAIMED",
          "This Actionable already has an active claim.",
          undefined,
          row.version,
        );
      }
      if (row.version !== request.version) {
        throw new AgentTaskClaimError(
          "VERSION_CONFLICT",
          "This Actionable changed after it was listed.",
          undefined,
          row.version,
        );
      }
      await recordObservedExpiry(tx, row, now);
      await tx.agentTaskClaim.create({
        data: {
          actionableId: row.id,
          agentId: request.agentId,
          claimTokenHash,
          claimedAt: now,
          leaseExpiresAt,
        },
      });
      await tx.actionable.update({
        where: { id: row.id },
        data: {
          version: { increment: 1 },
          updatedLabel: "agent claim",
        },
      });
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-claimed",
          summary: `Claimed by agent ${request.agentId}`,
          metadataJson: { agentId: request.agentId },
          occurredAt: now,
        },
      });
      return findTask(tx, sourceOrdinal);
    });
    if (!task?.agentTaskClaim) {
      throw new Error("Claim transaction did not return the created claim.");
    }
    return claimAgentTaskResponseSchema.parse({
      task: toAgentTaskSummary(task),
      claim: {
        agentId: request.agentId,
        claimToken,
        claimedAt: task.agentTaskClaim.claimedAt.toISOString(),
        renewedAt: task.agentTaskClaim.renewedAt.toISOString(),
        leaseExpiresAt: task.agentTaskClaim.leaseExpiresAt.toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof AgentTaskClaimError) throw error;
    const current = await findTask(prisma, sourceOrdinal);
    if (
      current?.agentTaskClaim &&
      current.agentTaskClaim.leaseExpiresAt > now
    ) {
      throw new AgentTaskClaimError(
        "ALREADY_CLAIMED",
        "This Actionable already has an active claim.",
        undefined,
        current.version,
      );
    }
    throw error;
  }
}

export async function renewAgentTaskClaim(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RenewAgentTaskClaimRequest,
  now = new Date(),
): Promise<RenewAgentTaskClaimResponse> {
  const request = parseInput(renewAgentTaskClaimRequestSchema, input);
  const result = await prisma.$transaction(async (tx) => {
    const row = await findTask(tx, sourceOrdinal);
    const claim = requireValidClaim(row, request.claimToken, now);
    if (claim === "expired") {
      await recordObservedExpiry(tx, row!, now);
      await tx.actionable.update({
        where: { id: row!.id },
        data: {
          version: { increment: 1 },
          updatedLabel: "agent claim expired",
        },
      });
      return { expired: true as const };
    }
    await tx.agentTaskClaim.update({
      where: { actionableId: row!.id },
      data: { leaseExpiresAt: leaseExpiry(now, request.leaseMinutes) },
    });
    return { expired: false as const, task: await findTask(tx, sourceOrdinal) };
  });
  if (result.expired) {
    throw new AgentTaskClaimError(
      "CLAIM_EXPIRED",
      "The claim lease expired and must be reacquired.",
    );
  }
  return renewAgentTaskClaimResponseSchema.parse({
    task: toAgentTaskSummary(result.task!),
  });
}

export async function releaseAgentTaskClaim(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ReleaseAgentTaskClaimRequest,
  now = new Date(),
): Promise<ReleaseAgentTaskClaimResponse> {
  const request = parseInput(releaseAgentTaskClaimRequestSchema, input);
  const result = await prisma.$transaction(async (tx) => {
    const row = await findTask(tx, sourceOrdinal);
    const claim = requireValidClaim(row, request.claimToken, now);
    if (claim === "expired") {
      await recordObservedExpiry(tx, row!, now);
      await tx.actionable.update({
        where: { id: row!.id },
        data: {
          version: { increment: 1 },
          updatedLabel: "agent claim expired",
        },
      });
      return { expired: true as const };
    }
    await tx.agentTaskClaim.delete({ where: { actionableId: row!.id } });
    await tx.actionable.update({
      where: { id: row!.id },
      data: { version: { increment: 1 }, updatedLabel: "agent release" },
    });
    await tx.activityEvent.create({
      data: {
        actionableId: row!.id,
        type: "agent-released",
        summary: `Released by agent ${claim.agentId}`,
        metadataJson: { agentId: claim.agentId },
        occurredAt: now,
      },
    });
    return { expired: false as const, task: await findTask(tx, sourceOrdinal) };
  });
  if (result.expired) {
    throw new AgentTaskClaimError(
      "CLAIM_EXPIRED",
      "The claim lease expired and must be reacquired.",
    );
  }
  return releaseAgentTaskClaimResponseSchema.parse({
    task: toAgentTaskSummary(result.task!),
  });
}

export async function releaseExpiredAgentTaskClaim(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ReleaseExpiredAgentClaimRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  const request = parseInput(releaseExpiredAgentClaimRequestSchema, input);
  return withClaimLock(String(sourceOrdinal), () =>
    prisma.$transaction(async (tx) => {
      const row = await findTask(tx, sourceOrdinal);
      if (!row) {
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      }
      const current = await getActionable(tx, sourceOrdinal);
      if (!current) {
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      }
      if (row.version !== request.version) {
        throw new VersionConflictError(current);
      }
      if (!row.agentTaskClaim) {
        throw new ExpiredAgentClaimReleaseConflictError(
          "CLAIM_NOT_FOUND",
          current,
        );
      }
      if (row.agentTaskClaim.leaseExpiresAt > now) {
        throw new ExpiredAgentClaimReleaseConflictError(
          "CLAIM_ACTIVE",
          current,
        );
      }
      await recordObservedExpiry(tx, row, now);
      await tx.actionable.update({
        where: { id: row.id },
        data: {
          version: { increment: 1 },
          updatedLabel: "agent claim expired",
        },
      });
      const released = await getActionable(tx, sourceOrdinal);
      if (!released) {
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      }
      return released;
    }),
  );
}
