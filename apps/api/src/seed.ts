import { createPrismaClient } from "./database.js";
import { importReviewedSeed, readReviewedSeed } from "./import-seed.js";

const prisma = createPrismaClient();

try {
  const document = await readReviewedSeed();
  const result = await importReviewedSeed(prisma, document);
  console.log(
    `Seed import complete: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged (${result.total} total).`,
  );
} finally {
  await prisma.$disconnect();
}
