import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertDatabaseSchemaReady,
  createPrismaClient,
  SchemaMigrationRequiredError,
  type AppPrismaClient,
} from "../src/database.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const prismaCli = resolve(repoRoot, "node_modules/prisma/build/index.js");
const migrationsPath = resolve(repoRoot, "prisma", "migrations");

let databasePath: string;
let databaseUrl: string;
let prisma: AppPrismaClient;
let expectedMigrations: string[];

beforeAll(async () => {
  const databaseName = `database-readiness-${randomUUID()}.db`;
  databasePath = resolve(repoRoot, "data", databaseName);
  databaseUrl = `file:./data/${databaseName}`;
  const databaseFile = await open(databasePath, "a");
  await databaseFile.close();
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
  prisma = createPrismaClient(databaseUrl);
  expectedMigrations = (await readdir(migrationsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (databasePath) {
    await Promise.all(
      ["", "-journal", "-shm", "-wal"].map((suffix) =>
        rm(`${databasePath}${suffix}`, { force: true }),
      ),
    );
  }
});

describe("database schema readiness", () => {
  it("rechecks the injected client's exact completed migration set", async () => {
    await expect(assertDatabaseSchemaReady(prisma)).resolves.toBeUndefined();

    const latest = expectedMigrations.at(-1)!;
    await prisma.$executeRawUnsafe(
      'UPDATE "_prisma_migrations" SET finished_at = NULL WHERE migration_name = ?',
      latest,
    );
    await expect(assertDatabaseSchemaReady(prisma)).rejects.toMatchObject({
      code: "SCHEMA_MIGRATION_REQUIRED",
      missingMigrations: [],
      incompleteMigrations: [latest],
      unexpectedMigrations: [],
    });

    await prisma.$executeRawUnsafe(
      'UPDATE "_prisma_migrations" SET finished_at = CURRENT_TIMESTAMP WHERE migration_name = ?',
      latest,
    );
    await expect(assertDatabaseSchemaReady(prisma)).resolves.toBeUndefined();

    const unresolvedId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES (?, ?, NULL, ?, NULL, NULL, CURRENT_TIMESTAMP, 0)`,
      unresolvedId,
      "0".repeat(64),
      latest,
    );
    await expect(assertDatabaseSchemaReady(prisma)).rejects.toMatchObject({
      incompleteMigrations: [latest],
    });
    await prisma.$executeRawUnsafe(
      'DELETE FROM "_prisma_migrations" WHERE id = ?',
      unresolvedId,
    );
    await expect(assertDatabaseSchemaReady(prisma)).resolves.toBeUndefined();

    const unexpected = "20990101000000_unexpected";
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES (?, ?, NULL, ?, NULL, NULL, CURRENT_TIMESTAMP, 0)`,
      randomUUID(),
      "0".repeat(64),
      unexpected,
    );
    await expect(assertDatabaseSchemaReady(prisma)).rejects.toMatchObject({
      missingMigrations: [],
      incompleteMigrations: [],
      unexpectedMigrations: [unexpected],
    });

    await prisma.$executeRawUnsafe(
      'DELETE FROM "_prisma_migrations" WHERE migration_name = ?',
      unexpected,
    );
    await prisma.$executeRawUnsafe(
      'DELETE FROM "_prisma_migrations" WHERE migration_name = ?',
      latest,
    );
    await expect(assertDatabaseSchemaReady(prisma)).rejects.toMatchObject({
      missingMigrations: [latest],
      incompleteMigrations: [],
      unexpectedMigrations: [],
    });
  });

  it("reports every migration missing when the ledger table is absent", async () => {
    const emptyPath = resolve(
      repoRoot,
      "data",
      `database-readiness-empty-${randomUUID()}.db`,
    );
    const empty = createPrismaClient(`file:${emptyPath.replaceAll("\\", "/")}`);
    try {
      await expect(assertDatabaseSchemaReady(empty)).rejects.toEqual(
        new SchemaMigrationRequiredError(expectedMigrations, [], []),
      );
    } finally {
      await empty.$disconnect();
      await rm(emptyPath, { force: true });
    }
  });

  it("does not relabel unrelated database failures", async () => {
    const failure = new Error("database unavailable");
    const failingClient = {
      $queryRaw: async () => {
        throw failure;
      },
    } as unknown as AppPrismaClient;

    await expect(assertDatabaseSchemaReady(failingClient)).rejects.toBe(
      failure,
    );
  });
});
