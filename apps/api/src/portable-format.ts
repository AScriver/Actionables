import { createHash } from "node:crypto";
import {
  portableDocumentSchema,
  portableFormat,
  portableSchemaVersion,
  type PortableActionable,
  type PortableDocument,
  type SeedDocument,
} from "@actionables/contracts";
import type { Prisma } from "./generated/prisma/client.js";
import type { AppPrismaClient } from "./database.js";

const actionFields = [
  "projectId",
  "repositoryId",
  "worktreeId",
  "title",
  "priority",
  "status",
  "statusProvenance",
  "effort",
  "evidenceState",
  "finding",
  "description",
  "research",
  "validation",
  "files",
  "tags",
  "manualBlocker",
  "dismissalReason",
  "completionOverride",
  "archive",
  "importedEvidence",
] as const;

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortObject(nested)]),
  );
}

export function canonicalStringify(value: unknown) {
  return JSON.stringify(sortObject(value));
}

export function sha256(value: unknown) {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

function byPortableId<T extends { portableId: string }>(left: T, right: T) {
  return left.portableId.localeCompare(right.portableId);
}

export function normalizePortableDocument(document: PortableDocument): PortableDocument {
  const normalized = {
    ...document,
    projects: [...document.projects].sort(byPortableId),
    repositories: [...document.repositories].sort(byPortableId),
    worktrees: [...document.worktrees].sort(byPortableId),
    actionables: document.actionables
      .map((item) => ({
        ...item,
        tags: [...item.tags].sort((left, right) => left.localeCompare(right)),
        files: [...item.files].sort((left, right) =>
          canonicalStringify(left).localeCompare(canonicalStringify(right)),
        ),
      }))
      .sort(byPortableId),
    statusHistory: [...document.statusHistory].sort(byPortableId),
    validationRecords: [...document.validationRecords].sort(byPortableId),
    userSources: [...document.userSources].sort(byPortableId),
    activities: [...document.activities].sort(byPortableId),
    hierarchy: [...document.hierarchy].sort(byPortableId),
    dependencies: [...document.dependencies].sort(byPortableId),
    relationshipSuggestions: [...document.relationshipSuggestions].sort(byPortableId),
  };
  return portableDocumentSchema.parse(normalized);
}

export function semanticPortableSnapshot(document: PortableDocument) {
  const normalized = normalizePortableDocument(document);
  return canonicalStringify({
    ...normalized,
    exportedAt: "<generated>",
    metadata: { ...normalized.metadata, sourceName: "<source-name>" },
  });
}

function jsonObject(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: Prisma.JsonValue) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sourceFiles(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.path !== "string" || !row.path) return [];
    return [{
      path: row.path,
      ...(typeof row.lines === "string" ? { lines: row.lines } : {}),
      ...(typeof row.symbol === "string" ? { symbol: row.symbol } : {}),
    }];
  });
}

function statusProvenance(row: {
  importProvider: string;
  statusProvenance: string;
  sourceStatusSuggestion: string | null;
}) {
  if (row.importProvider === "MANUAL") {
    return {
      kind: "user-authored" as const,
      note: row.statusProvenance || "Created by the user.",
    };
  }
  const suggested = ["Ready", "Researching", "Blocked"].includes(
    row.sourceStatusSuggestion ?? "",
  )
    ? (row.sourceStatusSuggestion as "Ready" | "Researching" | "Blocked")
    : undefined;
  return {
    kind: "neutral-import" as const,
    note: row.statusProvenance || "Imported without changing workflow ownership.",
    ...(suggested ? { suggestedStatus: suggested } : {}),
  };
}

function defaultOwnership(origin: "imported" | "user-authored") {
  return Object.fromEntries(actionFields.map((field) => [field, origin]));
}

export async function exportPortableDocument(
  prisma: AppPrismaClient,
  options: { exportedAt?: Date; sourceName?: string | null } = {},
): Promise<PortableDocument> {
  const [projects, repositories, worktrees, actionables, statusHistory, validations, sources, activities, hierarchy, dependencies] =
    await Promise.all([
      prisma.project.findMany(),
      prisma.repository.findMany({ include: { project: true } }),
      prisma.worktree.findMany({ include: { project: true, repository: true } }),
      prisma.actionable.findMany({
        include: { project: true, repository: true, worktree: true },
      }),
      prisma.actionableStatusHistory.findMany({ include: { actionable: true } }),
      prisma.validationRecord.findMany({ include: { actionable: true } }),
      prisma.userSourceReference.findMany({ include: { actionable: true } }),
      prisma.activityEvent.findMany({ include: { actionable: true } }),
      prisma.hierarchyRelationship.findMany({
        include: { parent: true, child: true },
      }),
      prisma.dependencyRelationship.findMany({
        include: { dependent: true, prerequisite: true },
      }),
    ]);

  const actionableId = new Map(actionables.map((item) => [item.id, item.externalKey]));
  const relationshipId = new Map([
    ...hierarchy.map((item) => [item.id, item.id] as const),
    ...dependencies.map((item) => [item.id, item.id] as const),
  ]);
  const context = (value: Prisma.JsonValue) =>
    Object.fromEntries(
      Object.entries(jsonObject(value)).map(([key, raw]) => {
        const text = String(raw ?? "");
        return [
          key,
          actionableId.get(text) ?? relationshipId.get(text) ?? text,
        ];
      }),
    );

  return normalizePortableDocument({
    format: portableFormat,
    schemaVersion: portableSchemaVersion,
    exportedAt: (options.exportedAt ?? new Date()).toISOString(),
    application: {
      name: "Actionables",
      version: "0.1.0",
      schema: "2026-07-25",
    },
    metadata: {
      sourceName: options.sourceName ?? "Actionables portable backup",
      sourceKind: "backup",
    },
    projects: projects.map((project) => ({
      portableId: project.externalKey,
      name: project.name,
      archive: {
        directArchivedAt: project.archivedAt?.toISOString() ?? null,
        inheritedFrom: [],
      },
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    })),
    repositories: repositories.map((repository) => ({
      portableId: repository.externalKey,
      projectId: repository.project.externalKey,
      name: repository.name,
      localPath: repository.localPath,
      archive: {
        directArchivedAt: repository.archivedAt?.toISOString() ?? null,
        inheritedFrom: repository.project.archivedAt ? ["project"] : [],
      },
      createdAt: repository.createdAt.toISOString(),
      updatedAt: repository.updatedAt.toISOString(),
    })),
    worktrees: worktrees.map((worktree) => ({
      portableId: worktree.externalKey,
      projectId: worktree.project.externalKey,
      repositoryId: worktree.repository.externalKey,
      name: worktree.name,
      localPath: worktree.localPath,
      archive: {
        directArchivedAt: worktree.archivedAt?.toISOString() ?? null,
        inheritedFrom: [
          ...(worktree.project.archivedAt ? ["project" as const] : []),
          ...(worktree.repository.archivedAt ? ["repository" as const] : []),
        ],
      },
      createdAt: worktree.createdAt.toISOString(),
      updatedAt: worktree.updatedAt.toISOString(),
    })),
    actionables: actionables.map((item) => {
      const origin = item.importProvider === "MANUAL" ? "user-authored" : "imported";
      const ownership = jsonObject(item.fieldOwnershipJson);
      return {
        portableId: item.externalKey,
        projectId: item.project.externalKey,
        repositoryId: item.repository.externalKey,
        worktreeId: item.worktree.externalKey,
        title: item.title,
        priority: item.priority as PortableActionable["priority"],
        status: item.status as PortableActionable["status"],
        statusProvenance: statusProvenance(item),
        effort: item.effort as PortableActionable["effort"],
        evidenceState: item.evidenceState as PortableActionable["evidenceState"],
        finding: item.finding,
        description: item.description,
        research: stringArray(item.researchJson),
        validation: stringArray(item.validationJson),
        files: sourceFiles(item.filesJson),
        tags: stringArray(item.tagsJson),
        manualBlocker: item.manualBlockerMd,
        dismissalReason: item.dismissalReasonMd,
        completionOverride: item.completionOverrideMd,
        archive: {
          directArchivedAt: item.archivedAt?.toISOString() ?? null,
          inheritedFrom: [
            ...(item.project.archivedAt ? ["project" as const] : []),
            ...(item.repository.archivedAt ? ["repository" as const] : []),
            ...(item.worktree.archivedAt ? ["worktree" as const] : []),
          ],
        },
        importedEvidence: {
          provider: item.importProvider,
          containerId: item.sourceContainerId,
          threadUrl: item.sourceThread,
          contentHash: item.contentHash,
          rawFragment: JSON.parse(JSON.stringify(item.rawFragmentJson)) as PortableActionable["importedEvidence"]["rawFragment"],
        },
        provenance: {
          origin,
          fieldOwnership: Object.keys(ownership).length
            ? (ownership as Record<string, "imported" | "user-authored">)
            : defaultOwnership(origin),
        },
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      };
    }),
    statusHistory: statusHistory.map((entry) => ({
      portableId: entry.id,
      actionableId: entry.actionable.externalKey,
      previousStatus: entry.previousStatus as PortableDocument["statusHistory"][number]["previousStatus"],
      newStatus: entry.newStatus as PortableDocument["statusHistory"][number]["newStatus"],
      origin: entry.origin,
      occurredAt: entry.occurredAt.toISOString(),
    })),
    validationRecords: validations.map((record) => ({
      portableId: record.id,
      actionableId: record.actionable.externalKey,
      type: record.type as PortableDocument["validationRecords"][number]["type"],
      outcome: record.outcome as PortableDocument["validationRecords"][number]["outcome"],
      notes: record.notesMd,
      evidence: record.evidenceMd,
      origin: record.origin,
      recordedAt: record.recordedAt.toISOString(),
      supersedesId: record.supersedesId,
    })),
    userSources: sources.map((source) => ({
      portableId: source.id,
      actionableId: source.actionable.externalKey,
      type: source.type as PortableDocument["userSources"][number]["type"],
      locator: source.locator,
      label: source.label,
      provenance: "user-added",
      createdAt: source.createdAt.toISOString(),
      removedAt: source.removedAt?.toISOString() ?? null,
    })),
    activities: activities.map((event) => ({
      portableId: event.id,
      actionableId: event.actionable.externalKey,
      type: event.type as PortableDocument["activities"][number]["type"],
      summary: event.summary,
      context: context(event.metadataJson),
      occurredAt: event.occurredAt.toISOString(),
    })),
    hierarchy: hierarchy.map((relationship) => ({
      portableId: relationship.id,
      parentId: relationship.parent.externalKey,
      childId: relationship.child.externalKey,
      createdAt: relationship.createdAt.toISOString(),
      detachedAt: relationship.detachedAt?.toISOString() ?? null,
      provenance: relationship.provenance,
    })),
    dependencies: dependencies.map((relationship) => ({
      portableId: relationship.id,
      dependentId: relationship.dependent.externalKey,
      prerequisiteId: relationship.prerequisite.externalKey,
      createdAt: relationship.createdAt.toISOString(),
      waivedAt: relationship.waivedAt?.toISOString() ?? null,
      waiverReason: relationship.waiverReason,
      removedAt: relationship.removedAt?.toISOString() ?? null,
      provenance: relationship.provenance,
    })),
    relationshipSuggestions: [],
  });
}

export function reviewedSeedToPortable(document: SeedDocument): PortableDocument {
  const exportedAt = "2026-07-24T00:00:00.000Z";
  const byOrdinal = new Map(document.items.map((item) => [item.ordinal, item.externalKey]));
  const suggestions = new Map<string, PortableDocument["relationshipSuggestions"][number]>();
  for (const item of document.items) {
    for (const prerequisite of item.blockedBy ?? []) {
      const prerequisiteId = byOrdinal.get(prerequisite);
      if (!prerequisiteId) continue;
      const portableId = `seed-suggestion-dependency-${item.ordinal}-${prerequisite}`;
      suggestions.set(`${item.externalKey}|${prerequisiteId}`, {
        portableId,
        kind: "dependency",
        fromId: item.externalKey,
        toId: prerequisiteId,
        reason: "The reviewed Codex prose suggested this prerequisite; it is not an established dependency.",
        provenance: document.source.threadUrl,
      });
    }
    for (const dependent of item.blocks ?? []) {
      const dependentId = byOrdinal.get(dependent);
      if (!dependentId) continue;
      const portableId = `seed-suggestion-dependency-${dependent}-${item.ordinal}`;
      suggestions.set(`${dependentId}|${item.externalKey}`, {
        portableId,
        kind: "dependency",
        fromId: dependentId,
        toId: item.externalKey,
        reason: "The reviewed Codex prose suggested this prerequisite; it is not an established dependency.",
        provenance: document.source.threadUrl,
      });
    }
  }
  return normalizePortableDocument({
    format: portableFormat,
    schemaVersion: portableSchemaVersion,
    exportedAt,
    application: {
      name: "Actionables",
      version: "0.1.0",
      schema: "2026-07-25",
    },
    metadata: {
      sourceName: "Reviewed WWW architecture findings (32 items)",
      sourceKind: "reviewed-seed",
    },
    projects: [{
      portableId: document.project.externalKey,
      name: document.project.name,
      archive: { directArchivedAt: null, inheritedFrom: [] },
    }],
    repositories: [{
      portableId: document.repository.externalKey,
      projectId: document.project.externalKey,
      name: document.repository.name,
      localPath: document.repository.localPath ?? null,
      archive: { directArchivedAt: null, inheritedFrom: [] },
    }],
    worktrees: [{
      portableId: document.worktree.externalKey,
      projectId: document.project.externalKey,
      repositoryId: document.repository.externalKey,
      name: document.worktree.name,
      localPath: document.worktree.localPath ?? null,
      archive: { directArchivedAt: null, inheritedFrom: [] },
    }],
    actionables: document.items.map((item) => ({
      portableId: item.externalKey,
      projectId: document.project.externalKey,
      repositoryId: document.repository.externalKey,
      worktreeId: document.worktree.externalKey,
      title: item.title,
      priority: item.priority,
      status: item.status,
      statusProvenance: item.statusProvenance,
      effort: item.effort,
      evidenceState: "Unclassified",
      finding: item.finding,
      description: item.description,
      research: item.research,
      validation: item.validation,
      files: item.files,
      tags: item.tags,
      manualBlocker: null,
      dismissalReason: null,
      completionOverride: null,
      archive: { directArchivedAt: null, inheritedFrom: [] },
      importedEvidence: {
        provider: document.source.provider,
        containerId: document.source.containerId,
        threadUrl: document.source.threadUrl,
        contentHash: sha256(item),
        rawFragment: item,
      },
      provenance: {
        origin: "imported",
        fieldOwnership: defaultOwnership("imported"),
      },
    })),
    statusHistory: [],
    validationRecords: [],
    userSources: [],
    activities: [],
    hierarchy: document.items.flatMap((item) => {
      const parentId = item.parentId ? byOrdinal.get(item.parentId) : undefined;
      return parentId
        ? [{
            portableId: `seed-hierarchy-${item.parentId}-${item.ordinal}`,
            parentId,
            childId: item.externalKey,
            createdAt: exportedAt,
            detachedAt: null,
            provenance: "reviewed-seed",
          }]
        : [];
    }),
    dependencies: [],
    relationshipSuggestions: [...suggestions.values()],
  });
}
