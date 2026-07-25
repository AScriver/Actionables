import { randomUUID } from "node:crypto";
import {
  actionableDetailResponseSchema,
  actionablesListResponseSchema,
  createActionableRequestSchema,
  healthResponseSchema,
  scopeOptionsResponseSchema,
  statusTransitionRequestSchema,
  updateActionableRequestSchema,
} from "@actionables/contracts";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { AppPrismaClient } from "./database.js";
import {
  createActionable,
  DomainValidationError,
  getActionable,
  listActionables,
  listScopeOptions,
  transitionActionable,
  updateActionable,
  VersionConflictError,
} from "./repository.js";

type BuildAppOptions = {
  prisma: AppPrismaClient;
  logger?: boolean | FastifyBaseLogger;
};

function fieldErrors(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
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

function parseRouteId(request: FastifyRequest, reply: FastifyReply, rawId: string) {
  const parsed = Number(rawId);
  if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(parsed) || parsed < 1) {
    problem(request, reply, 400, "INVALID_ID", "The actionable identifier is invalid.", {
      errors: { id: ["Actionable id must be a positive integer."] },
    });
    return null;
  }
  return parsed;
}

export function buildApp({ prisma, logger = false }: BuildAppOptions) {
  const app = Fastify({
    logger,
    genReqId(request) {
      const incoming = request.headers["x-correlation-id"];
      return typeof incoming === "string" && incoming.trim() ? incoming : randomUUID();
    },
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-correlation-id", request.id);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
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
          detail: "Review the saved version or reload its version and reapply your draft.",
          current: error.current,
        },
      );
    }

    request.log.error({ err: error }, "Unhandled request error");
    return problem(request, reply, 500, "INTERNAL_ERROR", "The request could not be completed.");
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

  app.get("/api/actionables", async () => {
    return actionablesListResponseSchema.parse(await listActionables(prisma));
  });

  app.post("/api/actionables", async (request, reply) => {
    const parsed = createActionableRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return problem(request, reply, 422, "VALIDATION_ERROR", "Check the actionable fields.", {
        errors: fieldErrors(parsed.error),
      });
    }

    const item = await createActionable(prisma, parsed.data);
    reply.header("location", `/actionables/${item.id}`);
    return reply.code(201).send(actionableDetailResponseSchema.parse({ item }));
  });

  app.get<{ Params: { id: string } }>("/api/actionables/:id", async (request, reply) => {
    const id = parseRouteId(request, reply, request.params.id);
    if (id === null) return;

    const item = await getActionable(prisma, id);
    if (!item) {
      return problem(request, reply, 404, "NOT_FOUND", "Actionable not found.");
    }

    return actionableDetailResponseSchema.parse({ item });
  });

  app.patch<{ Params: { id: string } }>("/api/actionables/:id", async (request, reply) => {
    const id = parseRouteId(request, reply, request.params.id);
    if (id === null) return;

    const parsed = updateActionableRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return problem(request, reply, 422, "VALIDATION_ERROR", "Check the actionable fields.", {
        errors: fieldErrors(parsed.error),
      });
    }

    const item = await updateActionable(prisma, id, parsed.data);
    if (!item) {
      return problem(request, reply, 404, "NOT_FOUND", "Actionable not found.");
    }
    return actionableDetailResponseSchema.parse({ item });
  });

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
        return problem(request, reply, 404, "NOT_FOUND", "Actionable not found.");
      }
      return actionableDetailResponseSchema.parse({ item });
    },
  );

  return app;
}
