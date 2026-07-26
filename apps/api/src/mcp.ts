import { createHash, timingSafeEqual } from "node:crypto";
import {
  agentTaskClaimCredentialSchema,
  claimAgentTaskRequestSchema,
  createAgentTaskRequestSchema,
  listAgentTasksRequestSchema,
  listAgentTasksResponseSchema,
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
  getClaimedAgentTask,
  listAgentTasks,
  recordClaimedAgentTaskValidation,
  releaseAgentTaskClaim,
  renewAgentTaskClaim,
  transitionClaimedAgentTask,
  updateClaimedAgentTask,
} from "./agent-tasks.js";
import { DomainValidationError, VersionConflictError } from "./repository.js";

const idSchema = z
  .number()
  .int()
  .positive()
  .describe("Public numeric Actionable ID.");
const claimedTaskSchema = releaseAgentTaskClaimRequestSchema.extend({
  id: idSchema,
});
const claimTaskSchema = claimAgentTaskRequestSchema.extend({ id: idSchema });
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
const recordValidationSchema =
  recordClaimedAgentTaskValidationRequestSchema.extend({ id: idSchema });

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
    research: z.array(z.string().max(400)).max(6),
    plannedValidation: z.array(z.string().max(400)).max(6),
    tags: z.array(z.string().max(60)).max(10),
    files: z
      .array(
        z
          .object({
            path: z.string().max(400),
            lines: z.string().max(80).optional(),
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
      })
      .strict(),
  })
  .strict();

const claimTaskOutputSchema = z
  .object({
    task: compactTaskSchema,
    claim: agentTaskClaimCredentialSchema,
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
  const compactText = (
    value: string,
    max: number,
    field: z.infer<typeof compactTruncatedFieldSchema>,
  ) => {
    if (value.length > max && !truncatedFields.includes(field)) {
      truncatedFields.push(field);
    }
    return truncate(value, max);
  };
  const subtasks = task.relationships.subtasks.slice(0, 5);
  const blockedBy = task.relationships.blockedBy.slice(0, 5);
  const blocks = task.relationships.blocks.slice(0, 5);
  return compactTaskSchema.parse({
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
    finding: compactText(task.finding, 1_500, "finding"),
    description: compactText(task.description, 2_500, "description"),
    research: task.research
      .slice(0, 6)
      .map((item) => compactText(item, 400, "research")),
    plannedValidation: task.validation
      .slice(0, 6)
      .map((item) => compactText(item, 400, "plannedValidation")),
    tags: task.tags.slice(0, 10),
    files: task.files.slice(0, 6).map((file) => ({
      path: compactText(file.path, 400, "files"),
      ...(file.lines ? { lines: compactText(file.lines, 80, "files") } : {}),
    })),
    userSources: task.userSources.slice(0, 5).map((source) => ({
      type: source.type,
      locator: compactText(source.locator, 500, "userSources"),
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
          if (!truncatedFields.includes("parent")) {
            truncatedFields.push("parent");
          }
        })
      : null,
    subtasks: subtasks.map((relationship) =>
      compactReference(relationship.child, () => {
        if (!truncatedFields.includes("subtasks")) {
          truncatedFields.push("subtasks");
        }
      }),
    ),
    blockedBy: blockedBy.map((relationship) =>
      compactReference(relationship.prerequisite, () => {
        if (!truncatedFields.includes("blockedBy")) {
          truncatedFields.push("blockedBy");
        }
      }),
    ),
    blocks: blocks.map((relationship) =>
      compactReference(relationship.dependent, () => {
        if (!truncatedFields.includes("blocks")) {
          truncatedFields.push("blocks");
        }
      }),
    ),
    truncation: {
      truncatedFields,
      omitted: {
        research: Math.max(0, task.research.length - 6),
        plannedValidation: Math.max(0, task.validation.length - 6),
        tags: Math.max(0, task.tags.length - 10),
        files: Math.max(0, task.files.length - 6),
        userSources: Math.max(0, task.userSources.length - 5),
        validationRecords: Math.max(0, task.validationRecords.length - 5),
        subtasks: Math.max(0, task.relationships.subtasks.length - 5),
        blockedBy: Math.max(0, task.relationships.blockedBy.length - 5),
        blocks: Math.max(0, task.relationships.blocks.length - 5),
      },
    },
  });
}

function success(output: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output as Record<string, unknown>,
  };
}

function recovery(code: string) {
  switch (code) {
    case "INVALID_REQUEST":
      return {
        retryable: false,
        nextAction: "Correct the reported input fields before calling again.",
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
    case "INVALID_CLAIM_TOKEN":
      return {
        retryable: false,
        nextAction:
          "Discard the token, then list mine or reclaim within the same work item.",
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
        "Use Actionables as the source of truth for substantive tracked work. Start by listing mine. Create a task only when the user authorizes it: for a top-level task, either provide existing scope IDs or provide repositoryPath with ensureScope true to resolve or create the local Git scope; for one direct subtask, provide parentId without placement fields. Generate one idempotency UUID per intended task and reuse it only for exact retries. Only list available tasks when the governing feature or bug provides its top-level workItemId; arbitrary pending work is intentionally unavailable. Claim within that same work item at the exact listed version; claim returns task detail. After claim, use the latest version and secret claim token without repeating agent identity; record actual validation before Done; release nonterminal claims on handoff. Never expose claim tokens.",
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
        "Create one task and return its detail. For a top-level task, either provide projectId, repositoryId, and worktreeId or provide repositoryPath with ensureScope true to resolve and provision the local Git scope. For one direct subtask, provide parentId and omit placement fields. Reuse the idempotency UUID only for an exact retry.",
      inputSchema: createAgentTaskRequestSchema,
      outputSchema: compactTaskSchema,
      annotations: { ...mutation, idempotentHint: true },
    },
    (input) =>
      runTool(async () => {
        const created = await createAgentTask(prisma, input);
        return compactTask(created.task, created.scopeProvisioning);
      }),
  );
  server.registerTool(
    "actionables.list_tasks",
    {
      title: "List Actionables",
      description:
        "List the current agent's unexpired claims, optionally within one feature or bug. Available discovery requires that work item's top-level Actionable ID and never returns arbitrary pending work.",
      inputSchema: listAgentTasksRequestSchema,
      outputSchema: listAgentTasksResponseSchema,
      annotations: readOnly,
    },
    (input) => runTool(() => listAgentTasks(prisma, input)),
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
        "Claim one task at its exact listed version within the same explicitly identified feature or bug work item. Returns compact task detail so work can begin immediately. Treat the claim token as a secret capability.",
      inputSchema: claimTaskSchema,
      outputSchema: claimTaskOutputSchema,
      annotations: mutation,
    },
    ({ id, ...input }) =>
      runTool(async () => {
        const claimed = await claimAgentTask(prisma, id, input);
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
    "actionables.update_task",
    {
      title: "Update claimed Actionable",
      description:
        "Update only supplied user-authored task fields using the claim token and latest version. Prefer append fields when adding research, planned checks, or sources.",
      inputSchema: updateTaskSchema,
      outputSchema: compactTaskSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    ({ id, ...input }) =>
      runTool(async () =>
        compactTask(await updateClaimedAgentTask(prisma, id, input)),
      ),
  );
  server.registerTool(
    "actionables.transition_task",
    {
      title: "Transition claimed Actionable",
      description:
        "Move a claimed task through a permitted lifecycle transition. Done requires qualifying validation and releases the claim.",
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
    "actionables.release_task",
    {
      title: "Release Actionable claim",
      description:
        "Release a valid nonterminal claim when abandoning or handing off work.",
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
