import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";

export function getDatabaseUrl() {
  return process.env.DATABASE_URL ?? "file:./data/actionables.db";
}

export function createPrismaClient(databaseUrl = getDatabaseUrl()) {
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}

export type AppPrismaClient = ReturnType<typeof createPrismaClient>;
