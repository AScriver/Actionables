import { randomUUID } from "node:crypto";
import {
  actionableQuerySchema,
  actionableDetailResponseSchema,
  actionablesListResponseSchema,
  auditActionableRelationshipsRequestSchema,
  archiveImpactResponseSchema,
  archiveMutationRequestSchema,
  archiveTargetKindSchema,
  createDependencyRequestSchema,
  createRepositoryRequestSchema,
  createRepositoryResponseSchema,
  createSubtaskRequestSchema,
  createTaskBreakdownRequestSchema,
  createValidationRecordRequestSchema,
  createActionableRequestSchema,
  dependencyActionRequestSchema,
  detachParentRequestSchema,
  healthResponseSchema,
  dashboardResponseSchema,
  groomActionableNotesRequestSchema,
  groomActionableNotesResponseSchema,
  helperAgentSettingsSchema,
  scopeOptionsResponseSchema,
  setParentRequestSchema,
  statusTransitionRequestSchema,
  updateActionableRequestSchema,
  updateHelperAgentSettingsRequestSchema,
  commitImportRequestSchema,
  importCommitResponseSchema,
  importPreviewResponseSchema,
  prepareImportCommitRequestSchema,
  prepareImportCommitResponseSchema,
  releaseExpiredAgentClaimRequestSchema,
  relationshipAuditResponseSchema,
  type ActionableQuery,
} from "@actionables/contracts";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { AppPrismaClient } from "./database.js";
import {
  createActionable,
  createRepository,
  archiveImpact,
  ArchiveVersionConflictError,
  DomainValidationError,
  getDashboard,
  getActionable,
  listActionablesWithQuery,
  listScopeOptions,
  recordValidation,
  setActionableArchived,
  setScopeArchived,
  transitionActionable,
  updateActionable,
  VersionConflictError,
} from "./repository.js";
import {
  createDependency,
  createSubtask,
  createTaskBreakdown,
  detachParent,
  removeDependency,
  restoreDependency,
  setParent,
  waiveDependency,
} from "./relationships.js";
import { DataImportService, PortableImportError } from "./data-import.js";
import { exportPortableDocument } from "./portable-format.js";
import { registerMcpRoutes } from "./mcp.js";
import {
  AgentTaskClaimError,
  ExpiredAgentClaimReleaseConflictError,
  releaseExpiredAgentTaskClaim,
} from "./agent-tasks.js";
import {
  AssistantContextTooLargeError,
  AssistantRunnerError,
  type AssistantRunner,
} from "./assistant-runner.js";
import { groomActionableNotes } from "./note-groomer.js";
import { auditWorkItemRelationships } from "./relationship-auditor.js";
import {
  getHelperAgentSettings,
  HelperAgentSettingsVersionConflictError,
  updateHelperAgentSettings,
} from "./helper-agent-settings.js";

type BuildAppOptions = {
  prisma: AppPrismaClient;
  logger?: boolean | FastifyBaseLogger;
  mcpBearerToken?: string;
  assistantRunner?: AssistantRunner;
};

function fieldErrors(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}) {
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "request";
    errors[field] ??= [];
    errors[field].push(issue.message);
  }
  return errors;
}

function problem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  options: {
    detail?: string;
    errors?: Record<string, string[]>;
    current?: unknown;
  } = {},
) {
  return reply.code(status).send({
    type: `https://actionables.local/problems/${code.toLowerCase()}`,
    title,
    status,
    code,
    requestId: request.id,
    ...options,
  });
}

function parseRouteId(
  request: FastifyRequest,
  reply: FastifyReply,
  rawId: string,
) {
  const parsed = Number(rawId);
  if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(parsed) || parsed < 1) {
    problem(
      request,
      reply,
      400,
      "INVALID_ID",
      "The actionable identifier is invalid.",
      {
        errors: { id: ["Actionable id must be a positive integer."] },
      },
    );
    return null;
  }
  return parsed;
}

function normalizeActionableQuery(raw: unknown): ActionableQuery {
  const defaults = actionableQuerySchema.parse({});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  let normalized = defaults;
  const source = raw as Record<string, unknown>;
  const keys: Array<keyof ActionableQuery> = [
    "project",
    "repository",
    "worktree",
    "status",
    "manualBlocked",
    "dependencyBlocked",
    "priority",
    "effort",
    "evidence",
    "tag",
    "archived",
    "parent",
    "validation",
    "reopened",
    "q",
    "sort",
  ];
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const parsed = actionableQuerySchema.safeParse({
      ...normalized,
      [key]: value,
    });
    if (parsed.success) normalized = parsed.data;
  }
  return normalized;
}

export function buildApp({
  prisma,
  logger = false,
  mcpBearerToken,
  assistantRunner,
}: BuildAppOptions) {
  const dataImports = new DataImportService(prisma);
  const app = Fastify({
    logger,
    bodyLimit: 6 * 1024 * 1024,
    genReqId(request) {
      const incoming = request.headers["x-correlation-id"];
      return typeof incoming === "string" && incoming.trim()
        ? incoming
        : randomUUID();
    },
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-correlation-id", request.id);
    return payload;
  });

  if (mcpBearerToken?.trim()) {
    registerMcpRoutes(app, prisma, mcpBearerToken);
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PortableImportError) {
      return problem(request, reply, error.status, error.code, error.message, {
        errors: error.errors,
      });
    }
    if (error instanceof DomainValidationError) {
      return problem(request, reply, 422, error.code, error.message, {
        errors: error.fieldErrors,
      });
    }
    if (error instanceof VersionConflictError) {
      return problem(
        request,
        reply,
        409,
        "VERSION_CONFLICT",
        "This actionable has a newer saved version.",
        {
          detail:
            "Review the saved version or reload its version and reapply your draft.",
          current: error.current,
        },
      );
    }
    if (error instanceof HelperAgentSettingsVersionConflictError) {
      return problem(
        request,
        reply,
        409,
        "VERSION_CONFLICT",
        "The helper agent settings have a newer saved version.",
        {
          detail: "Review the saved prompts before reapplying your changes.",
          current: error.current,
        },
      );
    }
    if (error instanceof ExpiredAgentClaimReleaseConflictError) {
      return problem(request, reply, 409, error.code, error.message, {
        detail:
          error.code === "CLAIM_ACTIVE"
            ? "The lease was renewed or has not expired. Reload before trying again."
            : "The claim was already released or expired elsewhere.",
        current: error.current,
      });
    }
    if (error instanceof ArchiveVersionConflictError) {
      return problem(
        request,
        reply,
        409,
        "VERSION_CONFLICT",
        "This archive target has a newer saved version.",
        {
          detail: `Reload the target and retry from version ${error.currentVersion}.`,
        },
      );
    }
    if (error instanceof AgentTaskClaimError && error.code === "NOT_FOUND") {
      return problem(request, reply, 404, "NOT_FOUND", "Actionable not found.");
    }
    if (error instanceof AssistantContextTooLargeError) {
      return problem(
        request,
        reply,
        422,
        "ASSISTANT_CONTEXT_TOO_LARGE",
        "The assistant context is too large for one request.",
        { detail: error.guidance },
      );
    }
    if (error instanceof AssistantRunnerError) {
      const status =
        error.code === "ASSISTANT_UNAVAILABLE"
          ? 503
          : error.code === "ASSISTANT_TIMEOUT"
            ? 504
            : 502;
      const detail =
        error.code === "ASSISTANT_UNAVAILABLE"
          ? "Confirm that Codex is installed and signed in, then retry."
          : error.code === "ASSISTANT_TIMEOUT"
            ? "The request exceeded the local assistant time limit. Retry with shorter notes."
            : "The model did not produce a usable proposal. No Actionable data was changed.";
      return problem(
        request,
        reply,
        status,
        error.code,
        "The local assistant could not complete the request.",
        { detail },
      );
    }
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : 0;
    if (statusCode === 400) {
      return problem(
        request,
        reply,
        400,
        "MALFORMED_JSON",
        "The uploaded JSON is malformed.",
      );
    }
    if (statusCode === 413) {
      return problem(
        request,
        reply,
        413,
        "IMPORT_TOO_LARGE",
        "The import exceeds the 6 MB server limit.",
      );
    }

    request.log.error({ err: error }, "Unhandled request error");
    return problem(
      request,
      reply,
      500,
      "INTERNAL_ERROR",
      "The request could not be completed.",
    );
  });

  app.get("/api/health", async (request) => {
    await prisma.project.count();
    return healthResponseSchema.parse({
      status: "ok",
      database: "ok",
      requestId: request.id,
    });
  });

  app.get("/api/scopes", async () => {
    return scopeOptionsResponseSchema.parse(await listScopeOptions(prisma));
  });

  app.get("/api/settings/helper-agents", async () => {
    return helperAgentSettingsSchema.parse(
      await getHelperAgentSettings(prisma),
    );
  });

  app.patch("/api/settings/helper-agents", async (request, reply) => {
    const parsed = updateHelperAgentSettingsRequestSchema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      return problem(
        request,
        reply,
        422,
        "VALIDATION_ERROR",
        "Check the helper agent prompts.",
        { errors: fieldErrors(parsed.error) },
      );
    }
    return helperAgentSettingsSchema.parse(
      await updateHelperAgentSettings(prisma, parsed.data),
    );
  });

  app.post("/api/repositories", async (request, reply) => {
    const parsed = createRepositoryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return problem(
        request,
        reply,
        422,
        "VALIDATION_ERROR",
        "Check the repository details.",
        { errors: fieldErrors(parsed.error) },
      );
    }

    const created = await createRepository(prisma, parsed.data);
    return reply.code(201).send(createRepositoryResponseSchema.parse(created));
  });

  app.post("/api/data/import-previews", async (request) => {
    return importPreviewResponseSchema.parse(
      await dataImports.preview(request.body),
    );
  });

  app.post<{ Params: { token: string } }>(
    "/api/data/import-previews/:token/selections",
    async (request, reply) => {
      const parsed = prepareImportCommitRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the import selections.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return prepareImportCommitResponseSchema.parse(
        dataImports.prepare(request.params.token, parsed.data),
      );
    },
  );

  app.post<{ Params: { token: string } }>(
    "/api/data/import-previews/:token/commit",
    async (request, reply) => {
      const parsed = commitImportRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the import commit.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return importCommitResponseSchema.parse(
        await dataImports.commit(request.params.token, parsed.data),
      );
    },
  );

  app.get("/api/data/export", async (_request, reply) => {
    const exportedAt = new Date();
    const stamp = exportedAt
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")
      .replace("T", "-");
    reply.header(
      "content-disposition",
      `attachment; filename="actionables-backup-${stamp}.json"`,
    );
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header(
      "x-actionables-sensitive-data",
      "technical paths and research notes",
    );
    return exportPortableDocument(prisma, { exportedAt });
  });

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/actionables",
    async (request) => {
      const query = normalizeActionableQuery(request.query);
      return actionablesListResponseSchema.parse(
        await listActionablesWithQuery(prisma, query),
      );
    },
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/dashboard",
    async (request) => {
      const query = normalizeActionableQuery(request.query);
      return dashboardResponseSchema.parse(await getDashboard(prisma, query));
    },
  );

  app.post("/api/actionables", async (request, reply) => {
    const parsed = createActionableRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return problem(
        request,
        reply,
        422,
        "VALIDATION_ERROR",
        "Check the actionable fields.",
        {
          errors: fieldErrors(parsed.error),
        },
      );
    }

    const item = await createActionable(prisma, parsed.data);
    reply.header("location", `/actionables/${item.id}`);
    return reply.code(201).send(actionableDetailResponseSchema.parse({ item }));
  });

  app.get<{ Params: { id: string } }>(
    "/api/actionables/:id",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;

      const item = await getActionable(prisma, id);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }

      return actionableDetailResponseSchema.parse({ item });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/assistant/note-grooming",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = groomActionableNotesRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the note-grooming request.",
          { errors: fieldErrors(parsed.error) },
        );
      }
      const item = await getActionable(prisma, id);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }
      if (item.version !== parsed.data.version) {
        throw new VersionConflictError(item);
      }
      if (!assistantRunner) {
        throw new AssistantRunnerError(
          "ASSISTANT_UNAVAILABLE",
          "No local assistant runner is configured.",
        );
      }
      const settings = await getHelperAgentSettings(prisma);
      return groomActionableNotesResponseSchema.parse(
        await groomActionableNotes(
          assistantRunner,
          item,
          settings.noteGroomerPrompt,
        ),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/assistant/relationship-audit",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = auditActionableRelationshipsRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the relationship-audit request.",
          { errors: fieldErrors(parsed.error) },
        );
      }
      const item = await getActionable(prisma, id);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }
      if (item.version !== parsed.data.version) {
        throw new VersionConflictError(item);
      }
      if (!assistantRunner) {
        throw new AssistantRunnerError(
          "ASSISTANT_UNAVAILABLE",
          "No local assistant runner is configured.",
        );
      }
      const settings = await getHelperAgentSettings(prisma);
      return relationshipAuditResponseSchema.parse(
        await auditWorkItemRelationships(
          prisma,
          assistantRunner,
          item,
          settings.relationshipAuditorPrompt,
        ),
      );
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/actionables/:id",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;

      const parsed = updateActionableRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the actionable fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }

      const item = await updateActionable(prisma, id, parsed.data);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }
      return actionableDetailResponseSchema.parse({ item });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/agent-claim/release-expired",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = releaseExpiredAgentClaimRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the expired claim release.",
          { errors: fieldErrors(parsed.error) },
        );
      }
      const item = await releaseExpiredAgentTaskClaim(prisma, id, parsed.data);
      return actionableDetailResponseSchema.parse({ item });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/status-transitions",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;

      const parsed = statusTransitionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the status transition.",
          { errors: fieldErrors(parsed.error) },
        );
      }

      const item = await transitionActionable(prisma, id, parsed.data);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }
      return actionableDetailResponseSchema.parse({ item });
    },
  );

  app.get<{ Params: { kind: string; id: string } }>(
    "/api/archive-impact/:kind/:id",
    async (request, reply) => {
      const kind = archiveTargetKindSchema.safeParse(request.params.kind);
      if (!kind.success) {
        return problem(
          request,
          reply,
          400,
          "INVALID_ARCHIVE_TARGET",
          "The archive target is invalid.",
        );
      }
      const impact = await archiveImpact(prisma, kind.data, request.params.id);
      if (!impact)
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Archive target not found.",
        );
      return archiveImpactResponseSchema.parse(impact);
    },
  );

  const actionableArchiveMutation =
    (archived: boolean) =>
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = archiveMutationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the archive request.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      const item = await setActionableArchived(
        prisma,
        id,
        parsed.data.version,
        archived,
      );
      if (!item)
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      return actionableDetailResponseSchema.parse({ item });
    };
  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/archive",
    actionableArchiveMutation(true),
  );
  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/restore",
    actionableArchiveMutation(false),
  );

  const scopeArchiveMutation =
    (archived: boolean) =>
    async (
      request: FastifyRequest<{ Params: { kind: string; id: string } }>,
      reply: FastifyReply,
    ) => {
      const kind = archiveTargetKindSchema
        .exclude(["actionable"])
        .safeParse(request.params.kind);
      if (!kind.success) {
        return problem(
          request,
          reply,
          400,
          "INVALID_ARCHIVE_TARGET",
          "The scope archive target is invalid.",
        );
      }
      const parsed = archiveMutationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the archive request.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      const scopes = await setScopeArchived(
        prisma,
        kind.data,
        request.params.id,
        parsed.data.version,
        archived,
      );
      if (!scopes)
        return problem(request, reply, 404, "NOT_FOUND", "Scope not found.");
      return scopeOptionsResponseSchema.parse(scopes);
    };
  app.post<{ Params: { kind: string; id: string } }>(
    "/api/scopes/:kind/:id/archive",
    scopeArchiveMutation(true),
  );
  app.post<{ Params: { kind: string; id: string } }>(
    "/api/scopes/:kind/:id/restore",
    scopeArchiveMutation(false),
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/validation-records",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;

      const parsed = createValidationRecordRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the validation record.",
          { errors: fieldErrors(parsed.error) },
        );
      }

      const item = await recordValidation(prisma, id, parsed.data);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }
      return actionableDetailResponseSchema.parse({ item });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/subtasks",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = createSubtaskRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the subtask fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return actionableDetailResponseSchema.parse({
        item: await createSubtask(prisma, id, parsed.data),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/task-breakdowns",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = createTaskBreakdownRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the task breakdown fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return actionableDetailResponseSchema.parse({
        item: await createTaskBreakdown(prisma, id, parsed.data),
      });
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/actionables/:id/parent",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = setParentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the hierarchy fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return actionableDetailResponseSchema.parse({
        item: await setParent(prisma, id, parsed.data),
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/actionables/:id/parent",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = detachParentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the hierarchy fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return actionableDetailResponseSchema.parse({
        item: await detachParent(prisma, id, parsed.data),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/dependencies",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = createDependencyRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the dependency fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return actionableDetailResponseSchema.parse({
        item: await createDependency(prisma, id, parsed.data),
      });
    },
  );

  const dependencyMutation =
    (action: typeof removeDependency, title: string) =>
    async (
      request: FastifyRequest<{
        Params: { id: string; relationshipId: string };
      }>,
      reply: FastifyReply,
    ) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = dependencyActionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(request, reply, 422, "VALIDATION_ERROR", title, {
          errors: fieldErrors(parsed.error),
        });
      }
      return actionableDetailResponseSchema.parse({
        item: await action(
          prisma,
          id,
          request.params.relationshipId,
          parsed.data,
        ),
      });
    };

  app.delete<{ Params: { id: string; relationshipId: string } }>(
    "/api/actionables/:id/dependencies/:relationshipId",
    dependencyMutation(removeDependency, "Check the dependency removal."),
  );
  app.post<{ Params: { id: string; relationshipId: string } }>(
    "/api/actionables/:id/dependencies/:relationshipId/waive",
    dependencyMutation(waiveDependency, "Check the dependency waiver."),
  );
  app.post<{ Params: { id: string; relationshipId: string } }>(
    "/api/actionables/:id/dependencies/:relationshipId/restore",
    dependencyMutation(restoreDependency, "Check the dependency restoration."),
  );

  return app;
}
