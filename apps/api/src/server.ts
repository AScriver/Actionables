import { buildApp } from "./app.js";
import { createPrismaClient } from "./database.js";

const prisma = createPrismaClient();
const app = buildApp({
  prisma,
  logger: true,
  mcpBearerToken: process.env.ACTIONABLES_MCP_TOKEN,
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
