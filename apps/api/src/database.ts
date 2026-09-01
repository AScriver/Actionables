import { readdir } from "node:fs/promises";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";

const migrationsDirectory = new URL(
  "../../../prisma/migrations/",
  import.meta.url,
);
let expectedMigrationNamesPromise: Promise<readonly string[]> | undefined;

type MigrationRow = {
  migration_name: string;
  finished_at: unknown | null;
  rolled_back_at: unknown | null;
};

function expectedMigrationNames() {
  expectedMigrationNamesPromise ??= readdir(migrationsDirectory, {
    withFileTypes: true,
  }).then((entries) =>
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
  );
  return expectedMigrationNamesPromise;
}

export class SchemaMigrationRequiredError extends Error {
  readonly code = "SCHEMA_MIGRATION_REQUIRED";

  constructor(
    public readonly missingMigrations: readonly string[],
    public readonly incompleteMigrations: readonly string[],
    public readonly unexpectedMigrations: readonly string[],
  ) {
    super(
      "The configured Actionables database does not match this application's migrations.",
    );
    this.name = "SchemaMigrationRequiredError";
  }
}

export function getDatabaseUrl() {
  return process.env.DATABASE_URL ?? "file:./data/actionables.db";
}

export function createPrismaClient(databaseUrl = getDatabaseUrl()) {
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}

export type AppPrismaClient = ReturnType<typeof createPrismaClient>;

export async function assertDatabaseSchemaReady(prisma: AppPrismaClient) {
  const expected = await expectedMigrationNames();
  const migrationTable = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name = '_prisma_migrations'
  `;
  const rows = migrationTable.length
    ? await prisma.$queryRaw<MigrationRow[]>`
        SELECT migration_name, finished_at, rolled_back_at
        FROM "_prisma_migrations"
      `
    : [];
  const ledgerNames = new Set(rows.map((row) => row.migration_name));
  const completedNames = new Set(
    rows
      .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
      .map((row) => row.migration_name),
  );
  const unresolvedNames = new Set(
    rows
      .filter((row) => row.finished_at === null && row.rolled_back_at === null)
      .map((row) => row.migration_name),
  );
  const expectedNames = new Set(expected);
  const missing = expected.filter((name) => !ledgerNames.has(name));
  const incomplete = expected.filter(
    (name) =>
      ledgerNames.has(name) &&
      (!completedNames.has(name) || unresolvedNames.has(name)),
  );
  const unexpected = [...ledgerNames]
    .filter((name) => !expectedNames.has(name))
    .sort();

  if (missing.length || incomplete.length || unexpected.length) {
    throw new SchemaMigrationRequiredError(missing, incomplete, unexpected);
  }
}
