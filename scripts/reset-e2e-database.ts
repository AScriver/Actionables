import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const databasePath = resolve("data/actionables-e2e.db");

for (const suffix of ["", "-journal", "-shm", "-wal"]) {
  await rm(`${databasePath}${suffix}`, { force: true });
}

console.log(`Reset disposable E2E database: ${databasePath}`);
