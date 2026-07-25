import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  seedDocumentSchema,
  type SeedDocument,
} from "@actionables/contracts";
import type { Prisma } from "./generated/prisma/client.js";
import type { AppPrismaClient } from "./database.js";

export const reviewedSeedUrl = new URL(
  "../../../seed/codex-www-architecture-review.v1.json",
  import.meta.url,
);

function contentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export async function readReviewedSeed(url = reviewedSeedUrl): Promise<SeedDocument> {
  const contents = await readFile(url, "utf8");
  return seedDocumentSchema.parse(JSON.parse(contents));
}

export async function importReviewedSeed(
  prisma: AppPrismaClient,
  document: SeedDocument,
) {
  return prisma.$transaction(async (transaction) => {
    const project = await transaction.project.upsert({
      where: { externalKey: document.project.externalKey },
      update: { name: document.project.name },
      create: {
        externalKey: document.project.externalKey,
        name: document.project.name,
      },
    });

    const repository = await transaction.repository.upsert({
      where: { externalKey: document.repository.externalKey },
      update: {
        name: document.repository.name,
        localPath: document.repository.localPath,
        projectId: project.id,
      },
      create: {
        externalKey: document.repository.externalKey,
        name: document.repository.name,
        localPath: document.repository.localPath,
        projectId: project.id,
      },
    });

    const worktree = await transaction.worktree.upsert({
      where: { externalKey: document.worktree.externalKey },
      update: {
        name: document.worktree.name,
        localPath: document.worktree.localPath,
        projectId: project.id,
        repositoryId: repository.id,
      },
      create: {
        externalKey: document.worktree.externalKey,
        name: document.worktree.name,
        localPath: document.worktree.localPath,
        projectId: project.id,
        repositoryId: repository.id,
      },
    });

    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const item of document.items) {
      const hash = contentHash(item);
      const existing = await transaction.actionable.findUnique({
        where: { externalKey: item.externalKey },
        select: { contentHash: true },
      });

      if (existing?.contentHash === hash) {
        unchanged += 1;
        continue;
      }

      const data = {
        sourceOrdinal: item.ordinal,
        title: item.title,
        priority: item.priority,
        status: item.status,
        statusProvenance: item.statusProvenance.note,
        sourceStatusSuggestion: item.statusProvenance.suggestedStatus,
        effort: item.effort,
        updatedLabel: item.updated,
        finding: item.finding,
        description: item.description,
        researchJson: asJson(item.research),
        validationJson: asJson(item.validation),
        filesJson: asJson(item.files),
        tagsJson: asJson(item.tags),
        blockedByOrdinalsJson: asJson(item.blockedBy ?? []),
        blocksOrdinalsJson: asJson(item.blocks ?? []),
        parentOrdinal: item.parentId,
        childOrdinalsJson: asJson(item.childIds ?? []),
        importProvider: document.source.provider,
        sourceContainerId: document.source.containerId,
        sourceThread: document.source.threadUrl,
        contentHash: hash,
        rawFragmentJson: asJson(item),
        projectId: project.id,
        repositoryId: repository.id,
        worktreeId: worktree.id,
      };

      await transaction.actionable.upsert({
        where: { externalKey: item.externalKey },
        update: data,
        create: {
          externalKey: item.externalKey,
          ...data,
        },
      });

      if (existing) updated += 1;
      else created += 1;
    }

    return { created, updated, unchanged, total: document.items.length };
  });
}
