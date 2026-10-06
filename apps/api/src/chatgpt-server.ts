import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveApiRuntimeConfig } from "@actionables/contracts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Fastify from "fastify";
import {
  buildChatgptApp,
  createChatgptMcpServer,
  readReviewHtml,
} from "./chatgpt-mcp.js";
import { assertDatabaseSchemaReady, createPrismaClient } from "./database.js";

async function reviewDatabaseUrl(environment: NodeJS.ProcessEnv) {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl?.startsWith("file:") || !isAbsolute(databaseUrl.slice(5)))
    throw new Error(
      "An explicit absolute file: DATABASE_URL is required; no default database is used.",
    );
  if (!(await stat(databaseUrl.slice(5))).isFile())
    throw new Error("DATABASE_URL must name an existing migrated SQLite file.");
  return databaseUrl;
}

export async function startChatgptServer(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const databaseUrl = await reviewDatabaseUrl(environment);
  const token = environment.ACTIONABLES_CHATGPT_MCP_TOKEN;
  if (!token || token.trim().length < 32)
    throw new Error(
      "ACTIONABLES_CHATGPT_MCP_TOKEN must contain at least 32 characters.",
    );
  if (!environment.CHATGPT_MCP_PORT?.trim())
    throw new Error("An explicit dedicated CHATGPT_MCP_PORT is required.");
  const runtime = resolveApiRuntimeConfig(environment.CHATGPT_MCP_PORT);
  const reviewHtml = await readReviewHtml();
  const prisma = createPrismaClient(databaseUrl, true);
  const app = buildChatgptApp({
    prisma,
    bearerToken: token,
    reviewHtml,
    logger: true,
  });
  app.addHook("onClose", () => prisma.$disconnect());
  try {
    await assertDatabaseSchemaReady(prisma);
    await app.listen({ host: runtime.apiHost, port: runtime.apiPort });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

export async function startChatgptStdioServer(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const databaseUrl = await reviewDatabaseUrl(environment);
  const reviewHtml = await readReviewHtml();
  const prisma = createPrismaClient(databaseUrl, true);
  const server = createChatgptMcpServer(
    prisma,
    { correlationId: randomUUID(), logger: Fastify().log },
    reviewHtml,
  );
  const close = async () => {
    await server.close();
    await prisma.$disconnect();
  };
  try {
    await assertDatabaseSchemaReady(prisma);
    await server.connect(new StdioServerTransport());
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const stdio = process.argv.includes("--stdio");
  const start = stdio ? startChatgptStdioServer : startChatgptServer;
  start()
    .then((server) => {
      if (stdio) process.stdin.once("end", () => void server.close());
      process.once("SIGINT", () => void server.close());
      process.once("SIGTERM", () => void server.close());
    })
    .catch(() => {
      // Startup diagnostics must not disclose database paths or credentials.
      process.stderr.write(
        "Actionables Review startup failed. Check its database, schema and UI build; HTTP mode also requires token and port configuration.\n",
      );
      process.exitCode = 1;
    });
}
