import { buildApp } from "./app.js";
import { createCodexAssistantRunner } from "./assistant-runner.js";
import { createPrismaClient } from "./database.js";

const prisma = createPrismaClient();
const assistantRunner = createCodexAssistantRunner({
  executable: process.env.ACTIONABLES_CODEX_PATH?.trim() || "codex",
  model: process.env.ACTIONABLES_ASSISTANT_MODEL?.trim() || "gpt-5.6-terra",
});
const app = buildApp({
  prisma,
  logger: true,
  mcpBearerToken: process.env.ACTIONABLES_MCP_TOKEN,
  assistantRunner,
  agentHomeDirectory: process.env.ACTIONABLES_AGENT_HOME,
});

async function close() {
  await app.close();
  await prisma.$disconnect();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);

try {
  const address = await app.listen({
    host: process.env.API_HOST ?? "127.0.0.1",
    port: Number(process.env.API_PORT ?? 4174),
  });
  app.log.info({ address }, "Actionables API listening");
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
}
