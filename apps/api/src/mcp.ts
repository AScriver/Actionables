import { createHash, timingSafeEqual } from "node:crypto";
import {
  actionableDetailSchema,
  actionableReadinessSchema,
  actionablesErrorPayload,
  agentTaskClaimCredentialSchema,
  agentTaskHandoffContentRecoveryMessage,
  agentTaskLeaseMinutesSchema,
  agentTaskListViewSchema,
  agentTaskVersionInputSchema,
  bulkCreateAgentTasksRequestSchema,
  bulkCreateAgentTasksResponseSchema,
  bulkPrepareAgentTasksRequestSchema,
  bulkPrepareAgentTasksResponseSchema,
  createAgentTaskRequestSchema,
  dismissAgentTaskRequestSchema,
  handoffClaimedAgentTaskRequestSchema,
  listAgentTasksResponseSchema,
  recoverAgentTaskClaimRequestSchema,
  recordClaimedAgentTaskValidationRequestSchema,
  releaseAgentTaskClaimRequestSchema,
  renewAgentTaskClaimRequestSchema,
  searchCompletedTasksRequestSchema,
  searchCompletedTasksResponseSchema,
  statusSchema,
  transitionClaimedAgentTaskRequestSchema,
  updateClaimedAgentTaskRequestSchema,
  type ActionableDetail,
  type ActionablesInternalRetryMode,
  type AgentTaskSummary,
} from "@actionables/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod/v4";
import {
  assertDatabaseSchemaReady,
  SchemaMigrationRequiredError,
  type AppPrismaClient,
} from "./database.js";
import {
  AgentTaskClaimError,
  bulkCreateAgentTasks,
  bulkPrepareAgentTasks,
  type BulkAgentTaskFailureContext,
  type AgentTaskScopeProvisioning,
  claimAgentTaskWithProjection,
  createAgentTask,
  dismissAgentTaskWithProjection,
  getClaimedAgentTask,
  getScopedTerminalAgentTask,
  handoffClaimedAgentTaskWithProjection,
  listAgentTasks,
  recoverAgentTaskClaimWithProjection,
  recordClaimedAgentTaskValidationWithProjection,
  releaseAgentTaskClaimWithProjection,
  renewAgentTaskClaimWithProjection,
  transitionClaimedAgentTaskWithProjection,
  updateClaimedAgentTaskWithProjection,
} from "./agent-tasks.js";
import {
  parsePersistedStatus,
  permittedTransitions,
} from "./actionable-transitions.js";
import { bundledActionablesWorkflowInstructions } from "./agent-integration.js";
import {
  DomainValidationError,
  searchCompletedTasks,
  VersionConflictError,
} from "./repository.js";

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
const taskReadCredentialFields = {
  includeArchived: z
    .boolean()
    .default(false)
    .describe(
      "Explicitly include archived terminal history when using workItemId. Unavailable for claimToken reads; never restores records.",
    ),
  claimToken: releaseAgentTaskClaimRequestSchema.shape.claimToken
    .optional()
    .describe("Valid claim token for exact reads of active claimed work."),
  workItemId: idSchema
    .optional()
    .describe(
      "Top-level Actionable ID authorizing read-only inspection of a Done or Dismissed task in that work item.",
    ),
};
const taskReadSchema = z
  .object({
    id: idSchema,
    ...taskReadCredentialFields,
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.claimToken === undefined) === (input.workItemId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["claimToken"],
        message:
          "Provide exactly one read authorization: claimToken for active claimed work or workItemId for terminal inspection.",
      });
    }
    if (input.includeArchived && input.workItemId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["includeArchived"],
        message:
          "Archive inclusion requires terminal inspection with workItemId.",
      });
    }
  });
const taskDetailFieldSchema = z
  .enum([
    "finding",
    "description",
    "resolution",
    "research",
    "plannedValidation",
    "files",
    "userSources",
    "parent",
    "subtasks",
    "blockedBy",
  ])
  .describe(
    "Task field to retrieve exactly, including full research and Resolution.",
  );
const taskDetailPageCharacters = 8_000;
const getTaskDetailSchema = z
  .object({
    id: idSchema,
    ...taskReadCredentialFields,
    version: agentTaskVersionInputSchema.describe(
      "Exact task version from the compact detail; prevents pages from mixing task states.",
    ),
    field: taskDetailFieldSchema,
    offset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe(
        "Character offset for this page; use 0 first, then each returned nextOffset.",
      ),
    contentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe(
        "Content hash returned by the first page; required with every nonzero offset.",
      ),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.claimToken === undefined) === (input.workItemId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["claimToken"],
        message:
          "Provide exactly one read authorization: claimToken for active claimed work or workItemId for terminal inspection.",
      });
    }
    if (input.offset > 0 && !input.contentHash) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "A returned contentHash is required after the first page.",
      });
    }
    if (input.includeArchived && input.workItemId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["includeArchived"],
        message:
          "Archive inclusion requires terminal inspection with workItemId.",
      });
    }
  });
const getTaskHistorySchema = z
  .object({
    id: idSchema,
    workItemId: idSchema.describe(
      "Top-level Actionable ID authorizing this Done or Dismissed history read.",
    ),
    includeArchived: taskReadCredentialFields.includeArchived.describe(
      "Explicitly include archived terminal history on every page; never restores records.",
    ),
    version: getTaskDetailSchema.shape.version.describe(
      "Exact task version from search_completed_tasks or get_task; keep it unchanged across pages.",
    ),
    offset: getTaskDetailSchema.shape.offset.describe(
      "History item offset: start at 0, then use each returned nextOffset until null.",
    ),
    contentHash: getTaskDetailSchema.shape.contentHash,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.offset > 0 && !input.contentHash) {
      context.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "A returned contentHash is required after the first page.",
      });
    }
  });
const claimTaskSchema = z
  .object({
    id: idSchema,
    workItemId: z
      .number()
      .int()
      .positive()
      .describe("Top-level Actionable ID for the current feature or bug."),
    version: agentTaskVersionInputSchema.describe(
      "Exact task version returned by list_tasks.",
    ),
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
const handoffTaskSchema = handoffClaimedAgentTaskRequestSchema
  .extend({ id: idSchema })
  .describe(agentTaskHandoffContentRecoveryMessage);

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
    workItemId: z.number().int().positive(),
    directTaskProgress: actionableDetailSchema.shape.directTaskProgress,
    recordId: z.string().min(1),
    title: z.string().max(240),
    priority: z.string().max(40),
    status: z.string().max(40),
    terminal: z.boolean(),
    archiveState: actionableDetailSchema.shape.archiveState,
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
    readiness: actionableReadinessSchema,
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
        truncatedFields: z.array(compactTruncatedFieldSchema).max(12),
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

const mutationChangedFieldSchema = z.enum([
  "title",
  "priority",
  "effort",
  "evidenceState",
  "finding",
  "description",
  "resolution",
  "research",
  "plannedValidation",
  "tags",
  "userSources",
  "files",
  "status",
  "validationRecords",
]);
const reconciliationFieldSchema = z.enum([
  "finding",
  "description",
  "research",
  "plannedValidation",
  "files",
  "userSources",
]);
const mutationCountFieldSchema = z.enum([
  "research",
  "plannedValidation",
  "userSources",
  "files",
  "validationRecords",
]);
const mutationReceiptSchema = z
  .object({
    id: z.number().int().positive(),
    version: z.number().int().positive(),
    status: statusSchema,
    changedFields: z.array(mutationChangedFieldSchema).max(14),
    claimReleased: z.boolean(),
    reconciliationFields: z.array(reconciliationFieldSchema).max(6),
    readiness: actionableReadinessSchema,
    permittedTransitions: z.array(statusSchema).max(20),
    counts: z
      .array(
        z
          .object({
            field: mutationCountFieldSchema,
            persisted: z.number().int().nonnegative(),
            duplicatesIgnored: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(5),
    lifecycleGuidance: z.string().min(1).max(600).optional(),
    claimLease: z
      .object({
        renewedAt: z.string().datetime(),
        leaseExpiresAt: z.string().datetime(),
      })
      .strict()
      .optional(),
    validation: z
      .object({
        id: z.string().min(1),
        qualifiesForCompletion: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

const claimTaskOutputSchema = z
  .object({
    task: compactTaskSchema,
    claim: agentTaskClaimCredentialSchema,
  })
  .strict();

const taskDetailPageSchema = z
  .object({
    id: z.number().int().positive(),
    version: z.number().int().positive(),
    field: taskDetailFieldSchema,
    offset: z.number().int().nonnegative(),
    totalLength: z.number().int().positive(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    json: z.string().max(taskDetailPageCharacters),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict();

const historyFieldSchema = z.enum([
  "research",
  "resolution",
  "userSources",
  "files",
  "sourceThread",
]);
const historyPropertySchema = z.enum([
  "type",
  "locator",
  "label",
  "path",
  "lines",
  "symbol",
]);
const historyItemIdentity = {
  field: historyFieldSchema,
  index: z.number().int().nonnegative(),
};
const historyItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...historyItemIdentity,
      kind: z.literal("value"),
      value: z.union([
        z.string(),
        z
          .object({
            type: z.string(),
            locator: z.string(),
            label: z.string().optional(),
          })
          .strict(),
        actionableDetailSchema.shape.files.element,
      ]),
    })
    .strict(),
  z
    .object({
      ...historyItemIdentity,
      kind: z.literal("text"),
      property: historyPropertySchema.optional(),
      offset: z.number().int().nonnegative(),
      totalLength: z.number().int().nonnegative(),
      text: z.string().max(1_000),
    })
    .strict(),
]);
const taskHistoryPageSchema = z
  .object({
    id: idSchema,
    workItemId: idSchema,
    version: z.number().int().positive(),
    status: z.enum(["Done", "Dismissed"]),
    archiveState: actionableDetailSchema.shape.archiveState,
    updatedAt: z.string().datetime(),
    contentHash: taskDetailPageSchema.shape.contentHash,
    fieldCounts: z
      .object({
        research: z.number().int().nonnegative(),
        userSources: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(historyItemSchema).max(40),
    offset: z.number().int().nonnegative(),
    totalItems: z.number().int().nonnegative(),
    remainingItems: z.number().int().nonnegative(),
    complete: z.boolean(),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict();
/** Bounded terminal history returned to MCP agents. */
export type TaskHistoryPage = z.infer<typeof taskHistoryPageSchema>;
type HistoryItem = TaskHistoryPage["items"][number];
type HistoryValues = Record<
  z.infer<typeof historyFieldSchema>,
  Array<z.infer<(typeof historyItemSchema.options)[0]>["value"]>
>;

/** Keeps whole values when they fit; large values become independently readable text. */
function* taskHistoryItems(values: HistoryValues): Generator<HistoryItem> {
  for (const field of historyFieldSchema.options) {
    for (const [index, value] of values[field].entries()) {
      const item = { field, index, kind: "value" as const, value };
      if (JSON.stringify(item).length <= taskDetailPageCharacters - 2) {
        yield item;
        continue;
      }
      const parts: Array<[string | undefined, string]> =
        typeof value === "string"
          ? [[undefined, value]]
          : Object.entries(value);
      for (const [property, text] of parts) {
        let offset = 0;
        do {
          let end = Math.min(offset + 1_000, text.length);
          if (end < text.length) {
            const boundary = Math.max(
              text.lastIndexOf("\n", end - 1),
              text.lastIndexOf(" ", end - 1),
            );
            if (boundary >= offset + 500) end = boundary + 1;
            // Preserve UTF-16 pairs and CRLF when no nearby word boundary fits.
            if (
              /[\uD800-\uDBFF]/u.test(text[end - 1]!) ||
              (text[end - 1] === "\r" && text[end] === "\n")
            )
              end -= 1;
          }
          yield {
            field,
            index,
            kind: "text",
            ...(property === undefined
              ? {}
              : { property: historyPropertySchema.parse(property) }),
            offset,
            totalLength: text.length,
            text: text.slice(offset, end),
          };
          offset = end;
        } while (offset < text.length);
      }
    }
  }
}

/** Projects one terminal snapshot without invoking claim reads or changing lifecycle state. */
function taskHistoryPage(
  task: ActionableDetail,
  input: z.infer<typeof getTaskHistorySchema>,
) {
  const values: HistoryValues = {
    research: task.research,
    resolution: [task.resolution],
    userSources: task.userSources.map(({ type, locator, label }) => ({
      type,
      locator,
      ...(label === undefined ? {} : { label }),
    })),
    files: task.files,
    sourceThread: [task.sourceThread],
  };
  const metadata = {
    id: task.id,
    workItemId: task.workItemId,
    version: task.version,
    status: task.status,
    archiveState: task.archiveState,
    updatedAt: task.updatedAt,
    fieldCounts: {
      research: task.research.length,
      userSources: task.userSources.length,
      files: task.files.length,
    },
  };
  const contentHash = createHash("sha256")
    .update(JSON.stringify({ metadata, values }))
    .digest("hex");
  if (input.contentHash && input.contentHash !== contentHash) {
    throw new AgentTaskClaimError(
      "VERSION_CONFLICT",
      "The task history changed while it was being paged.",
      undefined,
      task.version,
    );
  }
  const items: HistoryItem[] = [];
  let totalItems = 0;
  let size = 2;
  let pageFull = false;
  for (const item of taskHistoryItems(values)) {
    const ordinal = totalItems++;
    if (ordinal < input.offset || pageFull) continue;
    const length = JSON.stringify(item).length + (items.length ? 1 : 0);
    if (items.length === 40 || size + length > taskDetailPageCharacters) {
      pageFull = true;
      continue;
    }
    items.push(item);
    size += length;
  }
  if (input.offset >= totalItems) {
    throw new AgentTaskClaimError(
      "INVALID_REQUEST",
      "The requested history offset is outside the content.",
      { offset: ["Start at 0, then use only a returned nextOffset."] },
    );
  }
  const remainingItems = totalItems - input.offset - items.length;
  return taskHistoryPageSchema.parse({
    ...metadata,
    contentHash,
    items,
    offset: input.offset,
    totalItems,
    remainingItems,
    complete: remainingItems === 0,
    nextOffset: remainingItems ? input.offset + items.length : null,
  });
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function taskReference(item: { id: number; title: string; status: string }) {
  return { id: item.id, title: item.title, status: item.status };
}

function compactReference(
  item: Parameters<typeof taskReference>[0],
  markTruncated: () => void,
) {
  if (item.title.length > 160) markTruncated();
  return { ...taskReference(item), title: truncate(item.title, 160) };
}

function taskDetailField(
  task: ActionableDetail,
  field: z.infer<typeof taskDetailFieldSchema>,
) {
  switch (field) {
    case "finding":
      return task.finding;
    case "description":
      return task.description;
    case "resolution":
      return task.resolution;
    case "research":
      return task.research;
    case "plannedValidation":
      return task.validation;
    case "files":
      return task.files;
    case "userSources":
      return task.userSources.map(({ type, locator, label }) => ({
        type,
        locator,
        ...(label ? { label } : {}),
      }));
    case "parent":
      return task.relationships.parent
        ? taskReference(task.relationships.parent.parent)
        : null;
    case "subtasks":
      return task.relationships.subtasks.map(({ child }) =>
        taskReference(child),
      );
    case "blockedBy":
      return task.relationships.blockedBy.map(({ prerequisite }) =>
        taskReference(prerequisite),
      );
  }
}

function taskDetailPage(
  task: ActionableDetail,
  input: Pick<
    z.infer<typeof getTaskDetailSchema>,
    "version" | "field" | "offset" | "contentHash"
  >,
) {
  if (task.version !== input.version) throw new VersionConflictError(task);
  const json = JSON.stringify(taskDetailField(task, input.field));
  const contentHash = createHash("sha256").update(json).digest("hex");
  if (input.contentHash && input.contentHash !== contentHash) {
    throw new AgentTaskClaimError(
      "VERSION_CONFLICT",
      "The selected task detail changed while it was being paged.",
      undefined,
      task.version,
    );
  }
  if (input.offset >= json.length && input.offset !== 0) {
    throw new AgentTaskClaimError(
      "INVALID_REQUEST",
      "The requested detail offset is outside the selected field.",
      { offset: ["Start at 0, then use only a returned nextOffset."] },
    );
  }
  const nextOffset = Math.min(
    input.offset + taskDetailPageCharacters,
    json.length,
  );
  return taskDetailPageSchema.parse({
    id: task.id,
    version: task.version,
    field: input.field,
    offset: input.offset,
    totalLength: json.length,
    contentHash,
    json: json.slice(input.offset, nextOffset),
    nextOffset: nextOffset < json.length ? nextOffset : null,
  });
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
  for (const [field, count, affectsImplementation] of [
    ["research", omitted.research, true],
    ["plannedValidation", omitted.plannedValidation, true],
    ["files", omitted.files, true],
    ["userSources", omitted.userSources, true],
    ["validationRecords", omitted.validationRecords, false],
    ["subtasks", omitted.subtasks, true],
    ["blockedBy", omitted.blockedBy, true],
    ["blocks", omitted.blocks, false],
  ] as const) {
    if (count > 0) markTruncated(field, affectsImplementation);
  }
  const detail = {
    id: task.id,
    workItemId: task.workItemId,
    recordId: task.recordId,
    title: truncate(task.title, 240),
    priority: task.priority,
    status: task.status,
    terminal: task.status === "Done" || task.status === "Dismissed",
    archiveState: task.archiveState,
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
    readiness: task.readiness,
    directTaskProgress: task.directTaskProgress,
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
              "Critical detail was truncated. Page supported truncatedFields (finding, description, resolution, research, plannedValidation, files, userSources, parent, subtasks, blockedBy) with actionables.get_task_detail, the compact version and the same authorization and includeArchived. Pass contentHash with each nextOffset until null; join json and JSON-parse it. On VERSION_CONFLICT, discard pages and restart. On TERMINAL_READ_INVALIDATED, discard pages and stop terminal inspection. Do not move the task forward or edit files until reconciliation is complete.",
          }
        : {}),
    },
  });
}

type MutationReceiptTask = Pick<
  ActionableDetail | AgentTaskSummary,
  "id" | "version" | "status" | "readiness"
> &
  Partial<Pick<ActionableDetail, "permittedTransitions">>;

function mutationReceipt(
  task: MutationReceiptTask,
  options: {
    changedFields: string[];
    claimReleased: boolean;
    counts?: Array<{
      field: string;
      persisted: number;
      duplicatesIgnored: number;
    }>;
    claimLease?: {
      renewedAt: string;
      leaseExpiresAt: string;
    };
    validation?: {
      id: string;
      qualifiesForCompletion: boolean;
    };
  },
) {
  const changedFields = z
    .array(mutationChangedFieldSchema)
    .parse(options.changedFields)
    .sort(
      (left, right) =>
        mutationChangedFieldSchema.options.indexOf(left) -
        mutationChangedFieldSchema.options.indexOf(right),
    );
  const counts = mutationReceiptSchema.shape.counts
    .parse(options.counts ?? [])
    .sort(
      (left, right) =>
        mutationCountFieldSchema.options.indexOf(left.field) -
        mutationCountFieldSchema.options.indexOf(right.field),
    );
  const reconciliationFields = changedFields.filter(
    (field) => reconciliationFieldSchema.safeParse(field).success,
  );
  const missing = task.readiness.requiredForReady;
  return mutationReceiptSchema.parse({
    id: task.id,
    version: task.version,
    status: task.status,
    changedFields,
    claimReleased: options.claimReleased,
    reconciliationFields,
    readiness: task.readiness,
    permittedTransitions:
      task.permittedTransitions ??
      permittedTransitions(parsePersistedStatus(task.status), task.readiness),
    counts,
    ...(task.status === "Researching"
      ? {
          lifecycleGuidance:
            missing.length > 0
              ? `Ready remains unavailable. Satisfy every field in readiness.requiredForReady (${missing.join(", ")}) before transitioning; use finding, description, appendResearch, or appendPlannedValidation as named. Keep the task Researching and record remaining questions while investigation remains.`
              : "All persisted Ready prerequisites are satisfied. Keep this task Researching and record remaining questions while investigation remains; otherwise Ready is now permitted. Do not force a transition solely because a turn ended.",
        }
      : {}),
    ...(options.claimLease ? { claimLease: options.claimLease } : {}),
    ...(options.validation ? { validation: options.validation } : {}),
  });
}

function success(output: object): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: "Actionables operation succeeded. Read structuredContent for the authoritative result.",
      },
    ],
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

type McpToolFailureContext = {
  correlationId: string;
  internalRetryMode: ActionablesInternalRetryMode;
  logger: FastifyBaseLogger;
  toolName: string;
};

function migrationErrors(error: SchemaMigrationRequiredError) {
  return {
    migrations: [
      ...error.missingMigrations.map((name) => `Missing: ${name}`),
      ...error.incompleteMigrations.map((name) => `Incomplete: ${name}`),
      ...error.unexpectedMigrations.map((name) => `Unexpected: ${name}`),
    ],
  };
}

function failure(
  error: unknown,
  context: McpToolFailureContext,
): CallToolResult {
  let output: {
    code: string;
    detail: string;
    errors?: Record<string, string[]>;
    currentVersion?: number;
    retryAt?: string;
  };
  if (error instanceof AgentTaskClaimError) {
    output = {
      code: error.code,
      detail: error.message,
      ...(error.fieldErrors ? { errors: error.fieldErrors } : {}),
      ...(error.currentVersion ? { currentVersion: error.currentVersion } : {}),
      ...(error.retryAt ? { retryAt: error.retryAt } : {}),
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
  } else if (error instanceof SchemaMigrationRequiredError) {
    output = {
      code: error.code,
      detail: error.message,
      errors: migrationErrors(error),
    };
  } else {
    context.logger.error(
      {
        err: error,
        correlationId: context.correlationId,
        toolName: context.toolName,
      },
      "Unhandled Actionables MCP tool error",
    );
    output = {
      code: "INTERNAL_ERROR",
      detail: "The task operation could not be completed.",
    };
  }
  const payload = actionablesErrorPayload({
    ...output,
    correlationId: context.correlationId,
    internalRetryMode: context.internalRetryMode,
  });
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

async function runTool(
  context: McpToolFailureContext,
  operation: () => Promise<object>,
): Promise<CallToolResult> {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error, context);
  }
}

function createActionablesMcpServer(
  prisma: AppPrismaClient,
  requestContext: { correlationId: string; logger: FastifyBaseLogger },
) {
  const server = new McpServer(
    { name: "actionables", version: "0.1.0" },
    {
      instructions: bundledActionablesWorkflowInstructions(),
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
  const runReadTool = (toolName: string, operation: () => Promise<object>) =>
    runTool(
      {
        ...requestContext,
        toolName,
        internalRetryMode: "same_request",
      },
      operation,
    );
  const runMutationTool = (
    toolName: string,
    operation: () => Promise<object>,
  ) =>
    runTool(
      { ...requestContext, toolName, internalRetryMode: "never" },
      async () => {
        await assertDatabaseSchemaReady(prisma);
        return operation();
      },
    );
  const bulkFailureContext = (
    toolName: string,
  ): BulkAgentTaskFailureContext => ({
    correlationId: requestContext.correlationId,
    onInternalError(error) {
      requestContext.logger.error(
        {
          err: error,
          correlationId: requestContext.correlationId,
          toolName,
        },
        "Unhandled Actionables MCP bulk item error",
      );
    },
  });

  server.registerTool(
    "actionables.create_task",
    {
      title: "Create Actionable",
      description:
        "Create one task with a deliberate priority other than Unset, an effort estimate other than Unknown, and at least one meaningful tag, then return its detail. For a top-level task, either provide projectId, repositoryId, and worktreeId or provide repositoryPath with ensureScope true to resolve and provision the local Git scope. For a subtask at any depth, provide the original top-level Actionable as workItemId and its intended immediate parent as parentId; the parent must belong to that work item. Omit placement fields. The server inherits the parent's scope. Reuse the idempotency UUID only for an exact retry.",
      inputSchema: createAgentTaskRequestSchema,
      outputSchema: compactTaskSchema,
      annotations: { ...mutation, idempotentHint: true },
    },
    (input, extra) =>
      runMutationTool("actionables.create_task", async () => {
        const created = await createAgentTask(prisma, input, {
          threadId: requestThreadId(extra),
        });
        return compactTask(created.task, created.scopeProvisioning);
      }),
  );
  server.registerTool(
    "actionables.bulk_create_tasks",
    {
      title: "Preview or create Actionables in bulk",
      description:
        "Preview or create 1 through 25 explicitly authorized tasks in one ordered call. Every item uses the normal create_task scope, hierarchy, classification, and caller-stable idempotency-key rules. The whole request must first satisfy the published input schema. mode preview performs no writes; mode apply commits each schema-valid item atomically while allowing valid siblings to succeed when another item fails. Read every compact per-item outcome and retry an applied request only with the same keys and identical item content. No claim credential is returned.",
      inputSchema: bulkCreateAgentTasksRequestSchema,
      outputSchema: bulkCreateAgentTasksResponseSchema,
      annotations: { ...mutation, idempotentHint: true },
    },
    (input, extra) =>
      runMutationTool("actionables.bulk_create_tasks", () =>
        bulkCreateAgentTasks(
          prisma,
          input,
          { threadId: requestThreadId(extra) },
          bulkFailureContext("actionables.bulk_create_tasks"),
        ),
      ),
  );
  server.registerTool(
    "actionables.bulk_prepare_tasks",
    {
      title: "Preview or prepare Actionables in bulk",
      description:
        "Preview or prepare 1 through 25 explicit Inbox tasks created by the current Codex thread in one ordered call. The whole request must first satisfy the published input schema. mode preview validates current scope, hierarchy, lifecycle, version, claim availability, content, and idempotency without writing. mode apply handles each schema-valid item atomically: it claims for the current Codex thread, enters Researching when needed, saves the supplied preparation, reaches Ready only when every prerequisite passes, and releases the claim. A failed item is fully rolled back while valid siblings may succeed. Use the normal list, claim, and reconciliation workflow for pre-existing tasks. Read every compact per-item outcome; exact retries replay without duplicate writes. Claim credentials are never accepted or returned.",
      inputSchema: bulkPrepareAgentTasksRequestSchema,
      outputSchema: bulkPrepareAgentTasksResponseSchema,
      annotations: {
        ...mutation,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    (input, extra) =>
      runMutationTool("actionables.bulk_prepare_tasks", () =>
        bulkPrepareAgentTasks(
          prisma,
          input,
          { threadId: requestThreadId(extra) },
          bulkFailureContext("actionables.bulk_prepare_tasks"),
        ),
      ),
  );
  server.registerTool(
    "actionables.list_tasks",
    {
      title: "List Actionables",
      description:
        "List the current Codex thread's unexpired claims, optionally within one feature or bug. Thread identity comes from request metadata. Available discovery requires that work item's top-level Actionable ID and never returns arbitrary pending work. Scoped reads of Done or Dismissed work items succeed with workItem status and terminal true; items remains an active-work list and may be empty.",
      inputSchema: listTasksSchema,
      outputSchema: listAgentTasksResponseSchema,
      annotations: readOnly,
    },
    (input, extra) =>
      runReadTool("actionables.list_tasks", () => {
        const threadId = requestThreadId(extra);
        return listAgentTasks(prisma, {
          ...input,
          agentId: threadAgentId(threadId),
        });
      }),
  );
  server.registerTool(
    "actionables.search_completed_tasks",
    {
      title: "Search completed Actionables",
      description:
        "Search Done tasks across work items within an explicit projectId or repositoryId and a nonempty keyword query. Returns bounded field-labeled matches, IDs, scope, archive state and updatedAt (last modification, not completion date), newest public ID first. Continue with nextCursor and unchanged search inputs until null. Archived history is excluded unless includeArchived is true. Read research, Resolution and sources together with get_task_history using the result's id, workItemId, version and the same includeArchived option. History is evidence to verify against current code. Never claims, renews, reopens or changes records; does not authorize active work discovery.",
      inputSchema: searchCompletedTasksRequestSchema,
      outputSchema: searchCompletedTasksResponseSchema,
      annotations: readOnly,
    },
    (input) =>
      runReadTool("actionables.search_completed_tasks", () =>
        searchCompletedTasks(prisma, input),
      ),
  );
  server.registerTool(
    "actionables.get_task_history",
    {
      title: "Read completed Actionable history",
      description:
        "Read research, Resolution, userSources, files and sourceThread together for a Done or Dismissed task using id, top-level workItemId and version from search_completed_tasks or get_task. No claim or thread metadata is required. Returns whole native values when they fit and labeled plain-text chunks for oversized values, never serialized JSON fragments. Items identify field and zero-based index; text chunks add property for split references, offset and totalLength in UTF-16 units. Pages cap items at 40 and their serialized size at 8,000 characters. fieldCounts identifies empty collections; complete, remainingItems and nextOffset identify remaining content. Start at offset 0, then pass each nextOffset with the same version, contentHash and includeArchived until null. On VERSION_CONFLICT discard partial history and restart with a fresh version; on TERMINAL_READ_INVALIDATED discard it and stop terminal inspection. Never claims, renews, reopens, restores or changes records.",
      inputSchema: getTaskHistorySchema,
      outputSchema: taskHistoryPageSchema,
      annotations: readOnly,
    },
    (input) =>
      runReadTool("actionables.get_task_history", async () =>
        taskHistoryPage(
          await getScopedTerminalAgentTask(
            prisma,
            input.id,
            input.workItemId,
            input.version,
            input.includeArchived,
          ),
          input,
        ),
      ),
  );
  server.registerTool(
    "actionables.get_task",
    {
      title: "Get Actionable",
      description:
        "Fetch bounded details using exactly one read authorization: claimToken for active claimed work, or the top-level workItemId for read-only inspection of a Done or Dismissed task in that work item. Terminal history includes archived tasks and scopes only with includeArchived true. The response reports terminal and archive state; page truncated research or Resolution with get_task_detail. Use the returned version for a later mutation only after terminal work has been explicitly reopened and claimed.",
      inputSchema: taskReadSchema,
      outputSchema: compactTaskSchema,
      annotations: readOnly,
    },
    ({ id, claimToken, workItemId, includeArchived }) =>
      (claimToken ? runMutationTool : runReadTool)(
        "actionables.get_task",
        async () =>
          compactTask(
            claimToken
              ? await getClaimedAgentTask(prisma, id, { claimToken })
              : await getScopedTerminalAgentTask(
                  prisma,
                  id,
                  workItemId!,
                  undefined,
                  includeArchived,
                ),
          ),
      ),
  );
  server.registerTool(
    "actionables.get_task_detail",
    {
      title: "Get exact Actionable detail",
      description:
        "Fetch one fixed-size page of an exact task field, including research and Resolution, using the compact task's exact version and the same single read authorization: claimToken for active claimed work or top-level workItemId for terminal inspection. Keep includeArchived true on every archived history read. Start with offset 0, then pass each nextOffset until null with the first page's contentHash; concatenate json in offset order and JSON-parse the complete value. On VERSION_CONFLICT, discard partial json and restart from current compact detail. On TERMINAL_READ_INVALIDATED, discard partial pages and stop terminal inspection; active work requires the normal authorized list and claim flow. A successful page never returns a claim token, renews a claim, or changes the task version.",
      inputSchema: getTaskDetailSchema,
      outputSchema: taskDetailPageSchema,
      annotations: readOnly,
    },
    ({ id, claimToken, workItemId, includeArchived, ...input }) =>
      (claimToken ? runMutationTool : runReadTool)(
        "actionables.get_task_detail",
        async () =>
          taskDetailPage(
            claimToken
              ? await getClaimedAgentTask(prisma, id, { claimToken })
              : await getScopedTerminalAgentTask(
                  prisma,
                  id,
                  workItemId!,
                  input.version,
                  includeArchived,
                ),
            input,
          ),
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
      runMutationTool("actionables.claim_task", async () => {
        const threadId = requestThreadId(extra);
        return claimAgentTaskWithProjection(
          prisma,
          id,
          {
            ...input,
            agentId: threadAgentId(threadId),
          },
          (task, claim) =>
            claimTaskOutputSchema.parse({ task: compactTask(task), claim }),
        );
      }),
  );
  server.registerTool(
    "actionables.renew_task_claim",
    {
      title: "Renew Actionable claim",
      description:
        "Extend a valid claim during long read-only work. Successful mutations already renew the lease.",
      inputSchema: renewTaskSchema,
      outputSchema: mutationReceiptSchema,
      annotations: mutation,
    },
    ({ id, ...input }) =>
      runMutationTool("actionables.renew_task_claim", () =>
        renewAgentTaskClaimWithProjection(prisma, id, input, (response) => {
          const claim = response.task.claim;
          if (!claim) throw new Error("Renewed claim could not be read.");
          return mutationReceipt(response.task, {
            changedFields: [],
            claimReleased: false,
            claimLease: {
              renewedAt: claim.renewedAt,
              leaseExpiresAt: claim.leaseExpiresAt,
            },
          });
        }),
      ),
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
      runMutationTool("actionables.recover_task_claim", async () => {
        return recoverAgentTaskClaimWithProjection(
          prisma,
          id,
          input,
          { threadId: requestThreadId(extra) },
          (task, claim) =>
            claimTaskOutputSchema.parse({ task: compactTask(task), claim }),
        );
      }),
  );
  server.registerTool(
    "actionables.update_task",
    {
      title: "Update claimed Actionable",
      description:
        "Update only supplied user-authored task fields using the claim token and latest version. Set Resolution to describe completed changes and important implementation decisions before transitioning to Done. Prefer append fields when adding research, planned checks, or sources. The receipt reports changedFields, reconciliationFields, persisted and duplicate-ignored counts, readiness, and permitted transitions. If a composed call returns isError, stop before reading success fields or issuing dependent mutations.",
      inputSchema: updateTaskSchema,
      outputSchema: mutationReceiptSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    ({ id, ...input }) =>
      runMutationTool("actionables.update_task", async () => {
        return updateClaimedAgentTaskWithProjection(
          prisma,
          id,
          input,
          (result) =>
            mutationReceipt(result.task, {
              changedFields: result.changedFields,
              claimReleased: false,
              counts: result.counts,
            }),
        );
      }),
  );
  server.registerTool(
    "actionables.transition_task",
    {
      title: "Transition claimed Actionable",
      description:
        "Move a claimed task through Inbox to Researching to Ready to In progress. Ready requires non-empty finding, description, Research, and planned validation; use readiness.requiredForReady and permittedTransitions before requesting Ready or moving Ready to In progress. Return In progress directly to Researching only with a meaningful reason. Implementation changes must wait until In progress. Done requires non-empty Resolution plus qualifying validation and releases the claim. If a composed call returns isError, stop before reading success fields or issuing dependent mutations.",
      inputSchema: transitionTaskSchema,
      outputSchema: mutationReceiptSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    ({ id, ...input }) =>
      runMutationTool("actionables.transition_task", () =>
        transitionClaimedAgentTaskWithProjection(prisma, id, input, (task) =>
          mutationReceipt(task, {
            changedFields: ["status"],
            claimReleased:
              task.status === "Done" || task.status === "Dismissed",
          }),
        ),
      ),
  );
  server.registerTool(
    "actionables.dismiss_task",
    {
      title: "Dismiss unclaimed Actionable",
      description:
        "Dismiss one active unclaimed task created by the current Codex thread. Accepts only the public task ID and a required reason; thread identity and current version are resolved internally. Claimed work must use transition_task.",
      inputSchema: dismissTaskSchema,
      outputSchema: mutationReceiptSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    ({ id, ...input }, extra) =>
      runMutationTool("actionables.dismiss_task", () =>
        dismissAgentTaskWithProjection(
          prisma,
          id,
          input,
          {
            threadId: requestThreadId(extra),
          },
          (task) =>
            mutationReceipt(task, {
              changedFields: ["status"],
              claimReleased: false,
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
      outputSchema: mutationReceiptSchema,
      annotations: mutation,
    },
    ({ id, ...input }) =>
      runMutationTool("actionables.record_task_validation", () =>
        recordClaimedAgentTaskValidationWithProjection(
          prisma,
          id,
          input,
          (result) =>
            mutationReceipt(result.task, {
              changedFields: ["validationRecords"],
              claimReleased: false,
              counts: result.counts,
              validation: result.validation,
            }),
        ),
      ),
  );
  server.registerTool(
    "actionables.handoff_task",
    {
      title: "Handoff claimed Actionable",
      description: `Atomically save handoff content, then release the claim. ${agentTaskHandoffContentRecoveryMessage} If any requested write fails, no handoff content is saved and the claim remains active.`,
      inputSchema: handoffTaskSchema,
      outputSchema: mutationReceiptSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    ({ id, ...input }) =>
      runMutationTool("actionables.handoff_task", () =>
        handoffClaimedAgentTaskWithProjection(prisma, id, input, (result) =>
          mutationReceipt(result.task, {
            changedFields: result.changedFields,
            claimReleased: true,
            counts: result.counts,
            validation: result.validation,
          }),
        ),
      ),
  );
  server.registerTool(
    "actionables.release_task",
    {
      title: "Release Actionable claim",
      description:
        "Release only; this tool does not save or update task content. Use handoff_task when content must be saved before release. Before releasing a Researching task, record findings so far, remaining questions, and the next research step.",
      inputSchema: releaseTaskSchema,
      outputSchema: mutationReceiptSchema,
      annotations: {
        ...mutation,
        destructiveHint: false,
      },
    },
    ({ id, ...input }) =>
      runMutationTool("actionables.release_task", () =>
        releaseAgentTaskClaimWithProjection(prisma, id, input, (response) =>
          mutationReceipt(response.task, {
            changedFields: [],
            claimReleased: true,
          }),
        ),
      ),
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
    const server = createActionablesMcpServer(prisma, {
      correlationId: request.id,
      logger: request.log,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.setHeader("x-correlation-id", request.id);
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error(
        { err: error, correlationId: request.id },
        "MCP request failed",
      );
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
              data: { correlationId: request.id },
            },
            id: null,
          }),
        );
      }
    } finally {
      await server.close();
    }
  });
}
