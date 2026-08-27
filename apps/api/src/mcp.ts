import { createHash, timingSafeEqual } from "node:crypto";
import {
  agentTaskClaimCredentialSchema,
  agentTaskLeaseMinutesSchema,
  agentTaskListViewSchema,
  createAgentTaskRequestSchema,
  dismissAgentTaskRequestSchema,
  handoffClaimedAgentTaskRequestSchema,
  listAgentTasksResponseSchema,
  recoverAgentTaskClaimRequestSchema,
  recordClaimedAgentTaskValidationRequestSchema,
  releaseAgentTaskClaimRequestSchema,
  releaseAgentTaskClaimResponseSchema,
  renewAgentTaskClaimRequestSchema,
  renewAgentTaskClaimResponseSchema,
  transitionClaimedAgentTaskRequestSchema,
  updateClaimedAgentTaskRequestSchema,
  type ActionableDetail,
} from "@actionables/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod/v4";
import type { AppPrismaClient } from "./database.js";
import {
  AgentTaskClaimError,
  type AgentTaskScopeProvisioning,
  claimAgentTask,
  createAgentTask,
  dismissAgentTask,
  getClaimedAgentTask,
  handoffClaimedAgentTask,
  listAgentTasks,
  recoverAgentTaskClaim,
  recordClaimedAgentTaskValidation,
  releaseAgentTaskClaim,
  renewAgentTaskClaim,
  transitionClaimedAgentTask,
  updateClaimedAgentTaskWithReceipt,
} from "./agent-tasks.js";
import { DomainValidationError, VersionConflictError } from "./repository.js";

const idSchema = z
  .number()
  .int()
  .positive()
  .describe("Public numeric Actionable ID.");
const threadIdSchema = z.string().trim().min(1).max(120);
const listTasksSchema = z
  .object({
    view: agentTaskListViewSchema.default("mine"),
    workItemId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Top-level Actionable ID for the current feature or bug; required for available.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Maximum tasks to return, from 1 through 100."),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.view === "available" && input.workItemId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["workItemId"],
        message:
          "Available tasks require the top-level feature or bug work-item ID.",
      });
    }
  });
const claimedTaskSchema = releaseAgentTaskClaimRequestSchema.extend({
  id: idSchema,
});
const claimTaskSchema = z
  .object({
    id: idSchema,
    workItemId: z
      .number()
      .int()
      .positive()
      .describe("Top-level Actionable ID for the current feature or bug."),
    version: z
      .number()
      .int()
      .positive()
      .describe("Exact task version returned by list_tasks."),
    leaseMinutes: agentTaskLeaseMinutesSchema
      .optional()
      .describe(
        "Optional claim lease duration; omit to use the saved default.",
      ),
  })
  .strict();
const recoverTaskClaimSchema = recoverAgentTaskClaimRequestSchema.extend({
  id: idSchema,
});
const renewTaskSchema = renewAgentTaskClaimRequestSchema.extend({
  id: idSchema,
});
const releaseTaskSchema = releaseAgentTaskClaimRequestSchema.extend({
  id: idSchema,
});
const updateTaskSchema = updateClaimedAgentTaskRequestSchema.safeExtend({
  id: idSchema,
});
const transitionTaskSchema = transitionClaimedAgentTaskRequestSchema.extend({
  id: idSchema,
});
const dismissTaskSchema = dismissAgentTaskRequestSchema.extend({
  id: idSchema,
});
const recordValidationSchema =
  recordClaimedAgentTaskValidationRequestSchema.extend({ id: idSchema });
const handoffTaskSchema = handoffClaimedAgentTaskRequestSchema.extend({
  id: idSchema,
});

const compactReferenceSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().max(160),
    status: z.string().max(40),
  })
  .strict();

const compactTruncatedFieldSchema = z.enum([
  "finding",
  "description",
  "resolution",
  "research",
  "plannedValidation",
  "files",
  "userSources",
  "validationRecords",
  "parent",
  "subtasks",
  "blockedBy",
  "blocks",
]);

const compactTaskSchema = z
  .object({
    id: z.number().int().positive(),
    recordId: z.string().min(1),
    title: z.string().max(240),
    priority: z.string().max(40),
    status: z.string().max(40),
    effort: z.string().max(40),
    evidenceState: z.string().max(40),
    version: z.number().int().positive(),
    scope: z
      .object({
        projectId: z.string().min(1),
        projectName: z.string().min(1),
        repositoryId: z.string().min(1),
        repositoryName: z.string().min(1),
        worktreeId: z.string().min(1),
        worktreeName: z.string().min(1),
      })
      .strict(),
    scopeProvisioning: z
      .object({
        ensured: z.literal(true),
        repositoryPath: z.string().min(1).max(4_096),
        worktreePath: z.string().min(1).max(4_096),
        projectCreated: z.boolean(),
        repositoryCreated: z.boolean(),
        worktreeCreated: z.boolean(),
      })
      .strict()
      .optional(),
    updatedAt: z.string().datetime(),
    finding: z.string().max(1_500),
    description: z.string().max(2_500),
    resolution: z.string().max(2_500),
    research: z.array(z.string().max(400)).max(6),
    plannedValidation: z.array(z.string().max(400)).max(6),
    tags: z.array(z.string().max(60)).max(10),
    files: z
      .array(
        z
          .object({
            path: z.string().max(400),
            lines: z.string().max(80).optional(),
            symbol: z.string().max(160).optional(),
          })
          .strict(),
      )
      .max(6),
    userSources: z
      .array(
        z
          .object({
            type: z.string().max(40),
            locator: z.string().max(500),
            label: z.string().max(100).optional(),
          })
          .strict(),
      )
      .max(5),
    permittedTransitions: z.array(z.string().max(40)).max(20),
    validationRecords: z
      .array(
        z
          .object({
            id: z.string().min(1),
            type: z.string().max(40),
            outcome: z.string().max(40),
            notes: z.string().max(400),
            evidence: z.string().max(400),
            origin: z.string().max(100),
            recordedAt: z.string().datetime(),
            qualifiesForCompletion: z.boolean(),
          })
          .strict(),
      )
      .max(5),
    parent: compactReferenceSchema.nullable(),
    subtasks: z.array(compactReferenceSchema).max(5),
    blockedBy: z.array(compactReferenceSchema).max(5),
    blocks: z.array(compactReferenceSchema).max(5),
    truncation: z
      .object({
        truncatedFields: z.array(compactTruncatedFieldSchema).max(11),
        omitted: z
          .object({
            research: z.number().int().nonnegative(),
            plannedValidation: z.number().int().nonnegative(),
            tags: z.number().int().nonnegative(),
            files: z.number().int().nonnegative(),
            userSources: z.number().int().nonnegative(),
            validationRecords: z.number().int().nonnegative(),
            subtasks: z.number().int().nonnegative(),
            blockedBy: z.number().int().nonnegative(),
            blocks: z.number().int().nonnegative(),
          })
          .strict(),
        reconciliationGuidance: z.string().min(1).max(600).optional(),
      })
      .strict(),
  })
  .strict();

const researchUpdateReceiptSchema = z
  .object({
    id: z.number().int().positive(),
    version: z.number().int().positive(),
    status: z.string().max(40),
    appended: z.number().int().nonnegative(),
    duplicatesIgnored: z.number().int().nonnegative(),
    lifecycleGuidance: z.string().min(1).max(600).optional(),
  })
  .strict();

const updateTaskOutputSchema = compactTaskSchema.partial().extend({
  id: compactTaskSchema.shape.id,
  version: compactTaskSchema.shape.version,
  status: compactTaskSchema.shape.status,
  appended: researchUpdateReceiptSchema.shape.appended.optional(),
  duplicatesIgnored:
    researchUpdateReceiptSchema.shape.duplicatesIgnored.optional(),
  lifecycleGuidance:
    researchUpdateReceiptSchema.shape.lifecycleGuidance.optional(),
});

const claimTaskOutputSchema = z
  .object({
    task: compactTaskSchema,
    claim: agentTaskClaimCredentialSchema,
  })
  .strict();

const handoffTaskOutputSchema = z
  .object({
    task: compactTaskSchema,
    claimReleased: z.literal(true),
  })
  .strict();

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function compactReference(
  item: { id: number; title: string; status: string },
  markTruncated: () => void,
) {
  if (item.title.length > 160) markTruncated();
  return { id: item.id, title: truncate(item.title, 160), status: item.status };
}

function compactTask(
  task: ActionableDetail,
  scopeProvisioning?: AgentTaskScopeProvisioning,
) {
  const truncatedFields: Array<z.infer<typeof compactTruncatedFieldSchema>> =
    [];
  let requiresReconciliation = false;
  const markTruncated = (
    field: z.infer<typeof compactTruncatedFieldSchema>,
    affectsImplementation = false,
  ) => {
    if (!truncatedFields.includes(field)) truncatedFields.push(field);
    if (affectsImplementation) requiresReconciliation = true;
  };
  const compactText = (
    value: string,
    max: number,
    field: z.infer<typeof compactTruncatedFieldSchema>,
    affectsImplementation = false,
  ) => {
    if (value.length > max) markTruncated(field, affectsImplementation);
    return truncate(value, max);
  };
  const subtasks = task.relationships.subtasks.slice(0, 5);
  const blockedBy = task.relationships.blockedBy.slice(0, 5);
  const blocks = task.relationships.blocks.slice(0, 5);
  const omitted = {
    research: Math.max(0, task.research.length - 6),
    plannedValidation: Math.max(0, task.validation.length - 6),
    tags: Math.max(0, task.tags.length - 10),
    files: Math.max(0, task.files.length - 6),
    userSources: Math.max(0, task.userSources.length - 5),
    validationRecords: Math.max(0, task.validationRecords.length - 5),
    subtasks: Math.max(0, task.relationships.subtasks.length - 5),
    blockedBy: Math.max(0, task.relationships.blockedBy.length - 5),
    blocks: Math.max(0, task.relationships.blocks.length - 5),
  };
  requiresReconciliation = [
    omitted.research,
    omitted.plannedValidation,
    omitted.files,
    omitted.userSources,
    omitted.subtasks,
    omitted.blockedBy,
  ].some((count) => count > 0);
  const detail = {
    id: task.id,
    recordId: task.recordId,
    title: truncate(task.title, 240),
    priority: task.priority,
    status: task.status,
    effort: task.effort,
    evidenceState: task.evidenceState,
    version: task.version,
    scope: task.scope,
    ...(scopeProvisioning ? { scopeProvisioning } : {}),
    updatedAt: task.updatedAt,
    finding: compactText(task.finding, 1_500, "finding", true),
    description: compactText(task.description, 2_500, "description", true),
    resolution: compactText(task.resolution, 2_500, "resolution"),
    research: task.research
      .slice(0, 6)
      .map((item) => compactText(item, 400, "research", true)),
    plannedValidation: task.validation
      .slice(0, 6)
      .map((item) => compactText(item, 400, "plannedValidation", true)),
    tags: task.tags.slice(0, 10),
    files: task.files.slice(0, 6).map((file) => ({
      path: compactText(file.path, 400, "files", true),
      ...(file.lines
        ? { lines: compactText(file.lines, 80, "files", true) }
        : {}),
      ...(file.symbol
        ? { symbol: compactText(file.symbol, 160, "files", true) }
        : {}),
    })),
    userSources: task.userSources.slice(0, 5).map((source) => ({
      type: source.type,
      locator: compactText(source.locator, 500, "userSources", true),
      ...(source.label
        ? { label: compactText(source.label, 100, "userSources") }
        : {}),
    })),
    permittedTransitions: task.permittedTransitions,
    validationRecords: task.validationRecords.slice(-5).map((record) => ({
      id: record.id,
      type: record.type,
      outcome: record.outcome,
      notes: compactText(record.notes, 400, "validationRecords"),
      evidence: compactText(record.evidence, 400, "validationRecords"),
      origin: compactText(record.origin, 100, "validationRecords"),
      recordedAt: record.recordedAt,
      qualifiesForCompletion: record.qualifiesForCompletion,
    })),
    parent: task.relationships.parent
      ? compactReference(task.relationships.parent.parent, () => {
          markTruncated("parent", true);
        })
      : null,
    subtasks: subtasks.map((relationship) =>
      compactReference(relationship.child, () => {
        markTruncated("subtasks", true);
      }),
    ),
    blockedBy: blockedBy.map((relationship) =>
      compactReference(relationship.prerequisite, () => {
        markTruncated("blockedBy", true);
      }),
    ),
    blocks: blocks.map((relationship) =>
      compactReference(relationship.dependent, () => {
        markTruncated("blocks");
      }),
    ),
  };
  return compactTaskSchema.parse({
    ...detail,
    truncation: {
      truncatedFields,
      omitted,
      ...(requiresReconciliation
        ? {
            reconciliationGuidance:
              "Task detail that can affect scope or planned validation was truncated or omitted. Do not move the task forward or edit files until the full Actionable is reconciled and a newer complete detail is returned. If reconciliation is unavailable, record the blocker and hand off the task.",
          }
        : {}),
    },
  });
}

function success(output: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output as Record<string, unknown>,
  };
}

function requestThreadId(extra: { _meta?: Record<string, unknown> }) {
  const metadata = extra._meta;
  const direct = metadata?.threadId;
  const turnMetadata = metadata?.["x-codex-turn-metadata"];
  const nested =
    turnMetadata &&
    !Array.isArray(turnMetadata) &&
    typeof turnMetadata === "object" &&
    "thread_id" in turnMetadata
      ? turnMetadata.thread_id
      : undefined;
  if (
    typeof direct === "string" &&
    typeof nested === "string" &&
    direct !== nested
  ) {
    throw new AgentTaskClaimError(
      "THREAD_ID_REQUIRED",
      "The Codex thread metadata is inconsistent.",
    );
  }
  const parsed = threadIdSchema.safeParse(direct ?? nested);
  if (!parsed.success) {
    throw new AgentTaskClaimError(
      "THREAD_ID_REQUIRED",
      "This Actionables operation requires Codex thread metadata.",
    );
  }
  return parsed.data;
}

function threadAgentId(threadId: string) {
  return `codex:${threadId}`;
}

function recovery(code: string) {
  switch (code) {
    case "INVALID_REQUEST":
      return {
        retryable: false,
        nextAction: "Correct the reported input fields before calling again.",
      };
    case "RESEARCH_PHASE_REQUIRED":
      return {
        retryable: true,
        nextAction:
          "Call actionables.transition_task with status Researching, then begin investigation.",
      };
    case "RESEARCH_REQUIRED":
      return {
        retryable: true,
        nextAction:
          "Call actionables.update_task with appendResearch, then retry Ready using the returned version.",
      };
    case "RESOLUTION_REQUIRED":
      return {
        retryable: true,
        nextAction:
          "Call actionables.update_task with non-empty Resolution content, then retry Done using the returned version.",
      };
    case "NOT_FOUND":
    case "ARCHIVED":
    case "TERMINAL":
      return {
        retryable: false,
        nextAction:
          "Use an active nonterminal task from the current work item.",
      };
    case "VERSION_CONFLICT":
      return {
        retryable: true,
        nextAction:
          "Re-list or fetch the task, reconcile the newer state, then retry with its current version.",
      };
    case "ALREADY_CLAIMED":
      return {
        retryable: true,
        nextAction:
          "List mine; otherwise wait and re-list available tasks in the same work item.",
      };
    case "OWN_CLAIM_ACTIVE":
      return {
        retryable: true,
        nextAction:
          "Call actionables.recover_task_claim with this task ID and currentVersion to rotate and return fresh credentials for the current Codex thread.",
      };
    case "CLAIM_OWNER_MISMATCH":
      return {
        retryable: false,
        nextAction:
          "Use the Codex thread that owns the active claim, or wait for the claim to expire.",
      };
    case "CLAIM_NOT_FOUND":
      return {
        retryable: true,
        nextAction:
          "List mine; if the task is no longer owned, list available in the same work item and claim its current version.",
      };
    case "INVALID_CLAIM_TOKEN":
      return {
        retryable: true,
        nextAction:
          "Discard the token and list mine. If this thread still owns the task, call actionables.recover_task_claim with its current version; otherwise reclaim within the same work item.",
      };
    case "CLAIM_EXPIRED":
      return {
        retryable: true,
        nextAction:
          "Re-list available tasks in the same work item and claim the current version.",
      };
    case "IDEMPOTENCY_CONFLICT":
      return {
        retryable: false,
        nextAction:
          "Reuse the key only for an identical retry, or generate a new UUID for a new task.",
      };
    case "THREAD_ID_REQUIRED":
      return {
        retryable: false,
        nextAction:
          "Run this operation from a Codex thread that supplies MCP thread metadata.",
      };
    case "CREATOR_THREAD_MISMATCH":
      return {
        retryable: false,
        nextAction:
          "Use the Codex thread that created this unclaimed task, or use the normal claimed-task workflow.",
      };
    case "INTERNAL_ERROR":
      return {
        retryable: true,
        nextAction:
          "Retry once; if it repeats, inspect the local Actionables server log.",
      };
    default:
      return {
        retryable: true,
        nextAction:
          "Correct the reported task state or fields, then retry with the latest version.",
      };
  }
}

function failure(error: unknown): CallToolResult {
  let output: Record<string, unknown>;
  if (error instanceof AgentTaskClaimError) {
    output = {
      code: error.code,
      detail: error.message,
      ...(error.fieldErrors ? { errors: error.fieldErrors } : {}),
      ...(error.currentVersion ? { currentVersion: error.currentVersion } : {}),
    };
  } else if (error instanceof DomainValidationError) {
    output = {
      code: error.code,
      detail: error.message,
      errors: error.fieldErrors,
    };
  } else if (error instanceof VersionConflictError) {
    output = {
      code: "VERSION_CONFLICT",
      detail: error.message,
      currentVersion: error.current.version,
    };
  } else {
    output = {
      code: "INTERNAL_ERROR",
      detail: "The task operation could not be completed.",
    };
  }
  Object.assign(output, recovery(String(output.code)));
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
    isError: true,
  };
}

async function runTool(
  operation: () => Promise<object>,
): Promise<CallToolResult> {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

function createActionablesMcpServer(prisma: AppPrismaClient) {
  const server = new McpServer(
    { name: "actionables", version: "0.1.0" },
    {
      instructions:
        "Use Actionables as the source of truth for substantive tracked work. Codex thread identity is derived from MCP request metadata; never supply or invent an agent ID. Start by listing mine. Create a task only when the user authorizes it, and provide a deliberate priority other than Unset, an effort estimate other than Unknown, and at least one meaningful tag. For a top-level task, either provide existing scope IDs or provide repositoryPath with ensureScope true to resolve or create the local Git scope; for one direct subtask, provide the same top-level Actionable as workItemId and parentId without placement fields. Generate one idempotency UUID per intended task and reuse it only for exact retries. Only list available tasks when the governing feature or bug provides its top-level workItemId; arbitrary pending work is intentionally unavailable. Claim within that same work item at the exact listed version; a successful claim returns `{ task, claim }`. Read the latest version from `task.version` and the secret token from `claim.claimToken` for later claimed-task calls. Before treating returned compact task detail as complete, inspect `truncation.reconciliationGuidance` (`task.truncation.reconciliationGuidance` in claim and recovery responses). If it is present, follow it and do not move the task forward or edit files; if it is absent, normal flow may continue because any reported loss is noncritical to scope and planned validation. If the owning thread loses that token, list mine and call recover_task_claim with the listed version to rotate it; other threads cannot recover the claim. A creator thread may dismiss one of its own active unclaimed tasks with dismiss_task using only the task ID and a reason. Follow Inbox to Researching to Ready to In progress: enter Researching before investigation, record at least one non-empty note with appendResearch before Ready, and do not make implementation changes until the task is In progress. A task may remain Researching between turns only while additional investigation is genuinely required; before pausing, record findings so far, remaining questions, and the next research step, and do not force a transition merely because a turn ended. Before reporting research or the overall task complete, reconcile every owned Researching task: move it to Ready when research is sufficient but implementation remains, or advance it through the permitted lifecycle to Done with actual validation when research is the entire requested outcome. Never claim completion while an owned task remains Researching. Lifecycle enforcement governs Actionables mutations but cannot prevent filesystem edits outside the MCP; orchestration-level write gating requires separate authorization. Use handoff_task to atomically save handoff state and release; use release_task when only the claim should be released. Never expose claim tokens.",
    },
  );
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const mutation = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };

  server.registerTool(
    "actionables.create_task",
    {
      title: "Create Actionable",
      description:
        "Create one task with a deliberate priority other than Unset, an effort estimate other than Unknown, and at least one meaningful tag, then return its detail. For a top-level task, either provide projectId, repositoryId, and worktreeId or provide repositoryPath with ensureScope true to resolve and provision the local Git scope. For one direct subtask, provide the authorized top-level Actionable as both workItemId and parentId, and omit placement fields. Reuse the idempotency UUID only for an exact retry.",
      inputSchema: createAgentTaskRequestSchema,
      outputSchema: compactTaskSchema,
      annotations: { ...mutation, idempotentHint: true },
    },
    (input, extra) =>
      runTool(async () => {
        const created = await createAgentTask(prisma, input, {
          threadId: requestThreadId(extra),
        });
        return compactTask(created.task, created.scopeProvisioning);
      }),
  );
  server.registerTool(
    "actionables.list_tasks",
    {
      title: "List Actionables",
      description:
        "List the current Codex thread's unexpired claims, optionally within one feature or bug. Thread identity comes from request metadata. Available discovery requires that work item's top-level Actionable ID and never returns arbitrary pending work.",
      inputSchema: listTasksSchema,
      outputSchema: listAgentTasksResponseSchema,
      annotations: readOnly,
    },
    (input, extra) =>
      runTool(() => {
        const threadId = requestThreadId(extra);
        return listAgentTasks(prisma, {
          ...input,
          agentId: threadAgentId(threadId),
        });
      }),
  );
  server.registerTool(
    "actionables.get_task",
    {
      title: "Get claimed Actionable",
      description:
        "Fetch bounded details for one task using the valid claim token. Use the returned version for the next mutation.",
      inputSchema: claimedTaskSchema,
      outputSchema: compactTaskSchema,
      annotations: readOnly,
    },
    ({ id, ...input }) =>
      runTool(async () =>
        compactTask(await getClaimedAgentTask(prisma, id, input)),
      ),
  );
  server.registerTool(
    "actionables.claim_task",
    {
      title: "Claim Actionable",
      description:
        "Claim one task for the current Codex thread at its exact listed version within the same explicitly identified feature or bug work item. Thread identity comes from request metadata. A successful claim returns `{ task, claim }`; use `task.version` as the latest version and `claim.claimToken` as the secret capability for later claimed-task calls.",
      inputSchema: claimTaskSchema,
      outputSchema: claimTaskOutputSchema,
      annotations: mutation,
    },
    ({ id, ...input }, extra) =>
      runTool(async () => {
        const threadId = requestThreadId(extra);
        const claimed = await claimAgentTask(prisma, id, {
          ...input,
          agentId: threadAgentId(threadId),
        });
        return {
          task: compactTask(
            await getClaimedAgentTask(prisma, id, {
              claimToken: claimed.claim.claimToken,
            }),
          ),
          claim: claimed.claim,
        };
      }),
  );
  server.registerTool(
    "actionables.renew_task_claim",
    {
      title: "Renew Actionable claim",
      description:
        "Extend a valid claim during long read-only work. Successful mutations already renew the lease.",
      inputSchema: renewTaskSchema,
      outputSchema: renewAgentTaskClaimResponseSchema,
      annotations: mutation,
    },
    ({ id, ...input }) => runTool(() => renewAgentTaskClaim(prisma, id, input)),
  );
  server.registerTool(
    "actionables.recover_task_claim",
    {
      title: "Recover Actionable claim credentials",
      description:
        "Rotate and return fresh credentials for an unexpired claim already owned by the current Codex thread. Supply the current version from list_tasks(view: mine). The superseded token becomes invalid immediately, and concurrent calls using the same version have one winner.",
      inputSchema: recoverTaskClaimSchema,
      outputSchema: claimTaskOutputSchema,
      annotations: mutation,
    },
    ({ id, ...input }, extra) =>
      runTool(async () => {
        const recovered = await recoverAgentTaskClaim(prisma, id, input, {
          threadId: requestThreadId(extra),
        });
        return {
          task: compactTask(
            await getClaimedAgentTask(prisma, id, {
              claimToken: recovered.claim.claimToken,
            }),
          ),
          claim: recovered.claim,
        };
      }),
  );
  server.registerTool(
    "actionables.update_task",
    {
      title: "Update claimed Actionable",
      description:
        "Update only supplied user-authored task fields using the claim token and latest version. Set Resolution to describe completed changes and important implementation decisions before transitioning to Done. Prefer append fields when adding research, planned checks, or sources. Calls with appendResearch return a lean authoritative receipt with persisted and duplicate-ignored counts; newly persisted research on a Researching task also returns conditional lifecycle guidance.",
      inputSchema: updateTaskSchema,
      outputSchema: updateTaskOutputSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    ({ id, ...input }) =>
      runTool(async () => {
        const result = await updateClaimedAgentTaskWithReceipt(
          prisma,
          id,
          input,
        );
        if (!result.researchAppend) return compactTask(result.task);
        const shouldGuideLifecycle =
          result.researchAppend.appended > 0 &&
          result.task.status === "Researching";
        return researchUpdateReceiptSchema.parse({
          id: result.task.id,
          version: result.task.version,
          status: result.task.status,
          appended: result.researchAppend.appended,
          duplicatesIgnored: result.researchAppend.duplicatesIgnored,
          ...(shouldGuideLifecycle
            ? {
                lifecycleGuidance:
                  "Keep this task Researching and record remaining questions and the next research step when investigation remains; otherwise transition it to Ready before reporting research complete. Do not force a transition solely because a turn ended.",
              }
            : {}),
        });
      }),
  );
  server.registerTool(
    "actionables.transition_task",
    {
      title: "Transition claimed Actionable",
      description:
        "Move a claimed task through Inbox to Researching to Ready to In progress. Keep Researching while investigation remains; use Ready when research is sufficient but implementation remains. Ready requires a non-empty Research note, and implementation changes must wait until In progress. Done requires non-empty Resolution content plus qualifying validation and releases the claim.",
      inputSchema: transitionTaskSchema,
      outputSchema: compactTaskSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    ({ id, ...input }) =>
      runTool(async () =>
        compactTask(await transitionClaimedAgentTask(prisma, id, input)),
      ),
  );
  server.registerTool(
    "actionables.dismiss_task",
    {
      title: "Dismiss unclaimed Actionable",
      description:
        "Dismiss one active unclaimed task created by the current Codex thread. Accepts only the public task ID and a required reason; thread identity and current version are resolved internally. Claimed work must use transition_task.",
      inputSchema: dismissTaskSchema,
      outputSchema: compactTaskSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    ({ id, ...input }, extra) =>
      runTool(async () =>
        compactTask(
          await dismissAgentTask(prisma, id, input, {
            threadId: requestThreadId(extra),
          }),
        ),
      ),
  );
  server.registerTool(
    "actionables.record_task_validation",
    {
      title: "Record Actionable validation",
      description:
        "Record actual validation evidence for a claimed task. A current Passed record can qualify an In progress task for Done.",
      inputSchema: recordValidationSchema,
      outputSchema: compactTaskSchema,
      annotations: mutation,
    },
    ({ id, ...input }) =>
      runTool(async () =>
        compactTask(await recordClaimedAgentTaskValidation(prisma, id, input)),
      ),
  );
  server.registerTool(
    "actionables.handoff_task",
    {
      title: "Handoff claimed Actionable",
      description:
        "Atomically save handoff findings, additive file references, research, planned checks, and optional actual validation, then release the claim. If any requested write fails, no handoff content is saved and the claim remains active.",
      inputSchema: handoffTaskSchema,
      outputSchema: handoffTaskOutputSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    ({ id, ...input }) =>
      runTool(async () => ({
        task: compactTask(await handoffClaimedAgentTask(prisma, id, input)),
        claimReleased: true as const,
      })),
  );
  server.registerTool(
    "actionables.release_task",
    {
      title: "Release Actionable claim",
      description:
        "Release a valid nonterminal claim when abandoning or handing off work. Before releasing a Researching task, record findings so far, remaining questions, and the next research step.",
      inputSchema: releaseTaskSchema,
      outputSchema: releaseAgentTaskClaimResponseSchema,
      annotations: {
        ...mutation,
        destructiveHint: false,
      },
    },
    ({ id, ...input }) =>
      runTool(() => releaseAgentTaskClaim(prisma, id, input)),
  );

  return server;
}

function safeTokenMatches(candidate: string, expected: string) {
  const left = createHash("sha256").update(candidate).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function loopbackHostname(value: string) {
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(
    value,
  );
  return Boolean(match && (!match[1] || Number(match[1]) <= 65_535));
}

function validOrigin(value: string | undefined) {
  if (value === undefined) return true;
  try {
    const origin = new URL(value);
    return (
      ["http:", "https:"].includes(origin.protocol) &&
      loopbackHostname(origin.host) &&
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash
    );
  } catch {
    return false;
  }
}

async function authorizeMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  bearerToken: string,
) {
  if (
    typeof request.headers.host !== "string" ||
    !loopbackHostname(request.headers.host) ||
    !validOrigin(
      typeof request.headers.origin === "string"
        ? request.headers.origin
        : undefined,
    )
  ) {
    return reply.code(403).send({ error: "forbidden" });
  }
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    !safeTokenMatches(authorization.slice(7), bearerToken)
  ) {
    reply.header("www-authenticate", "Bearer");
    return reply.code(401).send({ error: "unauthorized" });
  }
}

export function registerMcpRoutes(
  app: FastifyInstance,
  prisma: AppPrismaClient,
  bearerToken: string,
) {
  const onRequest = (request: FastifyRequest, reply: FastifyReply) =>
    authorizeMcpRequest(request, reply, bearerToken);
  const methodNotAllowed = async (
    _request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    reply.header("allow", "POST");
    return reply.code(405).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  };

  app.get("/mcp", { onRequest }, methodNotAllowed);
  app.delete("/mcp", { onRequest }, methodNotAllowed);
  app.post("/mcp", { onRequest }, async (request, reply) => {
    const server = createActionablesMcpServer(prisma);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, "MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    } finally {
      await server.close();
    }
  });
}
