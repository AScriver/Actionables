import { resolveRuntimeConfig } from "@actionables/contracts";
import { buildApp } from "./app.js";
import { reconcileCodexMcpConfigAtStartup } from "./agent-integration.js";
import { createCodexAssistantRunner } from "./assistant-runner.js";
import { createPrismaClient } from "./database.js";

const runtimeConfig = resolveRuntimeConfig({
  webPort: process.env.WEB_PORT,
  apiPort: process.env.API_PORT,
});
const mcpBearerToken = process.env.ACTIONABLES_MCP_TOKEN;
const prisma = createPrismaClient();
const assistantRunner = createCodexAssistantRunner({
  executable: process.env.ACTIONABLES_CODEX_PATH?.trim() || "codex",
  model: process.env.ACTIONABLES_ASSISTANT_MODEL?.trim() || "gpt-5.6-terra",
});
const app = buildApp({
  prisma,
  logger: true,
  mcpBearerToken,
  runtimeConfig,
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
    host: runtimeConfig.apiHost,
    port: runtimeConfig.apiPort,
  });
  const codexReconciliation = await reconcileCodexMcpConfigAtStartup({
    environment: process.env,
    homeDirectory: process.env.ACTIONABLES_AGENT_HOME,
    runtimeConfig,
  });
  if (codexReconciliation.outcome === "updated") {
    app.log.info(codexReconciliation.message);
  } else if (codexReconciliation.outcome === "manual-review") {
    app.log.warn(codexReconciliation.message);
  }
  app.log.info(
    {
      address,
      webOrigin: runtimeConfig.webOrigin,
      apiOrigin: runtimeConfig.apiOrigin,
      healthEndpoint: runtimeConfig.healthEndpoint,
      mcpEndpoint: runtimeConfig.mcpEndpoint,
      mcpEnabled: Boolean(mcpBearerToken?.trim()),
    },
    "Actionables API listening",
  );
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
}
