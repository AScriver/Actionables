import { createPrismaClient } from "./database.js";
import { importSampleSeed, readSampleSeed } from "./import-seed.js";

const prisma = createPrismaClient();

try {
  const document = await readSampleSeed();
  const result = await importSampleSeed(prisma, document);
  console.log(
    `Seed import complete: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged (${result.total} total).`,
  );
} finally {
  await prisma.$disconnect();
}
