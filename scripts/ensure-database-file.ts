import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function ensureDatabaseFile(databaseUrl: string) {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL must use the file: protocol for the local SQLite milestone.");
  }

  const rawPath = databaseUrl.slice("file:".length);
  const databasePath = rawPath.startsWith("//")
    ? fileURLToPath(databaseUrl)
    : isAbsolute(rawPath)
      ? rawPath
      : resolve(process.cwd(), rawPath);

  await mkdir(dirname(databasePath), { recursive: true });
  const handle = await open(databasePath, "a");
  await handle.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await ensureDatabaseFile(process.env.DATABASE_URL ?? "file:./data/actionables.db");
}
