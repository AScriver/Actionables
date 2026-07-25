import { readFile } from "node:fs/promises";
import { seedDocumentSchema, type SeedDocument } from "@actionables/contracts";
import type { AppPrismaClient } from "./database.js";
import { DataImportService } from "./data-import.js";
import { reviewedSeedToPortable } from "./portable-format.js";

export const reviewedSeedUrl = new URL(
  "../../../seed/codex-www-architecture-review.v1.json",
  import.meta.url,
);

export async function readReviewedSeed(
  url = reviewedSeedUrl,
): Promise<SeedDocument> {
  const contents = await readFile(url, "utf8");
  return seedDocumentSchema.parse(JSON.parse(contents));
}

export async function importReviewedSeed(
  prisma: AppPrismaClient,
  document: SeedDocument,
) {
  const service = new DataImportService(prisma);
  const preview = await service.preview(reviewedSeedToPortable(document));
  const conflicts = Object.fromEntries(
    preview.items
      .filter((item) => item.classification === "conflict")
      .map((item) => [item.id, "skip" as const]),
  );
  const prepared = service.prepare(preview.previewToken, {
    contentDigest: preview.contentDigest,
    conflictResolutions: conflicts,
    acceptedSuggestionIds: [],
  });
  await service.commit(preview.previewToken, {
    contentDigest: preview.contentDigest,
    commitToken: prepared.commitToken,
    selectionsDigest: prepared.selectionsDigest,
  });
  const actionables = preview.items.filter(
    (item) => item.recordType === "actionable",
  );
  return {
    created: actionables.filter((item) => item.classification === "create")
      .length,
    updated: actionables.filter((item) => item.classification === "safe-update")
      .length,
    unchanged: actionables.filter(
      (item) =>
        item.classification === "no-op" || item.classification === "conflict",
    ).length,
    total: document.items.length,
  };
}
