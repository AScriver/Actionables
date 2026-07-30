import { randomUUID } from "node:crypto";
import {
  portableDocumentSchema,
  portableFormat,
  portableSchemaVersion,
  type CommitImportRequest,
  type ImportCommitResponse,
  type ImportPreviewItem,
  type ImportPreviewResponse,
  type PortableActionable,
  type PortableDocument,
  type PrepareImportCommitRequest,
  type PrepareImportCommitResponse,
} from "@actionables/contracts";
import type { Prisma } from "./generated/prisma/client.js";
import type { AppPrismaClient } from "./database.js";
import {
  canonicalStringify,
  exportPortableDocument,
  normalizePortableDocument,
  sha256,
} from "./portable-format.js";

type Client = AppPrismaClient | Prisma.TransactionClient;
type Count = ImportPreviewResponse["totals"];
type RecordType =
  | "project"
  | "repository"
  | "worktree"
  | "actionable"
  | "status-history"
  | "validation"
  | "user-source"
  | "activity"
  | "hierarchy"
  | "dependency"
  | "relationship-suggestion";

type MutationPlan = {
  recordType: RecordType;
  portableId: string;
  classification: ImportPreviewItem["classification"];
  safeFields: string[];
  nextBaseline?: Record<string, unknown>;
};

type Analysis = {
  response: Omit<ImportPreviewResponse, "previewToken" | "expiresAt">;
  plans: MutationPlan[];
};

type StoredPreview = {
  document: PortableDocument | null;
  response: ImportPreviewResponse;
  fingerprint: string;
  expiresAt: number;
  authorization?: {
    commitToken: string;
    selectionsDigest: string;
    acceptedSuggestionIds: string[];
    expiresAt: number;
    consumed: boolean;
  };
};

const emptyCount = (): Count => ({
  creates: 0,
  safeUpdates: 0,
  noOps: 0,
  conflicts: 0,
  invalid: 0,
  missingReferences: 0,
  integrityFailures: 0,
  suggestions: 0,
});

const countKey = {
  create: "creates",
  "safe-update": "safeUpdates",
  "no-op": "noOps",
  conflict: "conflicts",
  invalid: "invalid",
  "missing-reference": "missingReferences",
  "integrity-failure": "integrityFailures",
  suggestion: "suggestions",
} as const;

const json = (value: unknown) => value as Prisma.InputJsonValue;
const same = (left: unknown, right: unknown) =>
  canonicalStringify(left) === canonicalStringify(right);
const directArchive = (value: { directArchivedAt: string | null }) =>
  value.directArchivedAt;

export class PortableImportError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly errors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

function inspectJson(
  value: unknown,
  maxDepth = 40,
  depth = 0,
  path = "document",
): string[] {
  if (depth > maxDepth)
    return [`${path} exceeds the maximum nesting depth of ${maxDepth}.`];
  if (!value || typeof value !== "object") return [];
  const errors: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      errors.push(`${path}.${key} is not allowed.`);
    }
    errors.push(...inspectJson(nested, maxDepth, depth + 1, `${path}.${key}`));
    if (errors.length >= 50) return errors;
  }
  return errors;
}

function invalidPreview(
  raw: unknown,
  errors: Array<{ path: string; message: string }>,
): Omit<ImportPreviewResponse, "previewToken" | "expiresAt"> {
  const digest = sha256(raw);
  const items = errors.map((error, index): ImportPreviewItem => ({
    id: `invalid:${index}`,
    recordType: error.path.split(".")[0] || "document",
    portableId: error.path,
    display: error.path,
    classification: "invalid",
    changes: [],
    errors: [error.message],
  }));
  const totals = emptyCount();
  totals.invalid = items.length;
  return {
    contentDigest: digest,
    schemaVersion: portableSchemaVersion,
    compatibility:
      "Schema version 1 is supported exactly. Future versions require an explicit migration.",
    canCommit: false,
    items,
    totals,
    totalsByRecordType: {
      document: { ...emptyCount(), invalid: items.length },
    },
    archiveEffects: [],
    lifecycleEffects: [],
    affectedActionableIds: [],
  };
}

async function databaseFingerprint(client: Client) {
  const [
    projects,
    repositories,
    worktrees,
    actionables,
    statusHistory,
    validations,
    sources,
    activities,
    hierarchy,
    dependencies,
    importRuns,
  ] = await Promise.all([
    client.project.findMany({
      select: { externalKey: true, version: true, importBaselineJson: true },
      orderBy: { externalKey: "asc" },
    }),
    client.repository.findMany({
      select: { externalKey: true, version: true, importBaselineJson: true },
      orderBy: { externalKey: "asc" },
    }),
    client.worktree.findMany({
      select: { externalKey: true, version: true, importBaselineJson: true },
      orderBy: { externalKey: "asc" },
    }),
    client.actionable.findMany({
      select: {
        externalKey: true,
        version: true,
        importBaselineJson: true,
        fieldOwnershipJson: true,
      },
      orderBy: { externalKey: "asc" },
    }),
    client.actionableStatusHistory.findMany({ orderBy: { id: "asc" } }),
    client.validationRecord.findMany({ orderBy: { id: "asc" } }),
    client.userSourceReference.findMany({ orderBy: { id: "asc" } }),
    client.activityEvent.findMany({ orderBy: { id: "asc" } }),
    client.hierarchyRelationship.findMany({ orderBy: { id: "asc" } }),
    client.dependencyRelationship.findMany({ orderBy: { id: "asc" } }),
    client.importRun.findMany({ orderBy: { id: "asc" } }),
  ]);
  return sha256(
    JSON.parse(
      JSON.stringify({
        projects,
        repositories,
        worktrees,
        actionables,
        statusHistory,
        validations,
        sources,
        activities,
        hierarchy,
        dependencies,
        importRuns,
      }),
    ),
  );
}

function addItem(
  items: ImportPreviewItem[],
  totals: Count,
  totalsByRecordType: Record<string, Count>,
  item: ImportPreviewItem,
) {
  items.push(item);
  totals[countKey[item.classification]] += 1;
  totalsByRecordType[item.recordType] ??= emptyCount();
  totalsByRecordType[item.recordType]![countKey[item.classification]] += 1;
}

function fieldObject(item: PortableActionable): Record<string, unknown> {
  return {
    projectId: item.projectId,
    repositoryId: item.repositoryId,
    worktreeId: item.worktreeId,
    title: item.title,
    priority: item.priority,
    status: item.status,
    statusProvenance: item.statusProvenance,
    effort: item.effort,
    evidenceState: item.evidenceState,
    finding: item.finding,
    description: item.description,
    resolution: item.resolution,
    research: item.research,
    validation: item.validation,
    files: item.files,
    tags: item.tags,
    manualBlocker: item.manualBlocker,
    dismissalReason: item.dismissalReason,
    completionOverride: item.completionOverride,
    archive: directArchive(item.archive),
    importedEvidence: item.importedEvidence,
  };
}

function baselineObject(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function legacySeedBaseline(
  raw: Prisma.JsonValue,
  incoming: PortableActionable,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (
    typeof item.title !== "string" ||
    typeof item.finding !== "string" ||
    typeof item.description !== "string"
  ) {
    return null;
  }
  return {
    projectId: incoming.projectId,
    repositoryId: incoming.repositoryId,
    worktreeId: incoming.worktreeId,
    title: item.title,
    priority: item.priority,
    status: item.status,
    statusProvenance: item.statusProvenance,
    effort: item.effort,
    evidenceState: "Unclassified",
    finding: item.finding,
    description: item.description,
    resolution: incoming.resolution,
    research: item.research,
    validation: item.validation,
    files: item.files,
    tags: item.tags,
    manualBlocker: null,
    dismissalReason: null,
    completionOverride: null,
    archive: null,
    importedEvidence: incoming.importedEvidence,
  };
}

function compareFields(
  recordType: RecordType,
  portableId: string,
  display: string,
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  baseline: Record<string, unknown>,
) {
  const changes: ImportPreviewItem["changes"] = [];
  const safeFields: string[] = [];
  const nextBaseline = { ...baseline };
  let conflict = false;
  let preservedLocal = false;

  for (const field of Object.keys(incoming).sort()) {
    const currentValue = current[field];
    const incomingValue = incoming[field];
    const hasBaseline = Object.hasOwn(baseline, field);
    const baselineValue = baseline[field];
    if (same(currentValue, incomingValue)) {
      nextBaseline[field] = incomingValue;
      continue;
    }
    if (hasBaseline && same(currentValue, baselineValue)) {
      safeFields.push(field);
      nextBaseline[field] = incomingValue;
      changes.push({
        field,
        current: currentValue,
        incoming: incomingValue,
        reason:
          "Safe update: the local field still matches the last imported baseline.",
      });
      continue;
    }
    if (hasBaseline && same(incomingValue, baselineValue)) {
      preservedLocal = true;
      changes.push({
        field,
        current: currentValue,
        incoming: incomingValue,
        reason: "No source change: the local user edit is preserved.",
      });
      continue;
    }
    conflict = true;
    changes.push({
      field,
      current: currentValue,
      incoming: incomingValue,
      reason: hasBaseline
        ? "Conflict: both the source and local value changed from the imported baseline."
        : "Conflict: no trusted import baseline exists for this differing field.",
    });
  }

  const classification = conflict
    ? "conflict"
    : safeFields.length
      ? "safe-update"
      : "no-op";
  return {
    item: {
      id: `${recordType}:${portableId}`,
      recordType,
      portableId,
      display,
      classification,
      changes,
      errors:
        preservedLocal && !changes.length ? ["Local edits are preserved."] : [],
    } satisfies ImportPreviewItem,
    plan: {
      recordType,
      portableId,
      classification,
      safeFields,
      nextBaseline,
    } satisfies MutationPlan,
  };
}

function currentActionFields(
  item: PortableActionable,
): Record<string, unknown> {
  return fieldObject(item);
}

function genericComparable(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "inheritedFrom"),
  );
}

function integrityItems(
  document: PortableDocument,
  current: PortableDocument,
): ImportPreviewItem[] {
  const issues: ImportPreviewItem[] = [];
  const add = (
    recordType: RecordType,
    portableId: string,
    classification: "invalid" | "missing-reference" | "integrity-failure",
    message: string,
  ) => {
    issues.push({
      id: `${classification}:${recordType}:${portableId}:${issues.length}`,
      recordType,
      portableId,
      display: portableId,
      classification,
      changes: [],
      errors: [message],
    });
  };

  const groups: Array<[RecordType, Array<{ portableId: string }>]> = [
    ["project", document.projects],
    ["repository", document.repositories],
    ["worktree", document.worktrees],
    ["actionable", document.actionables],
    ["status-history", document.statusHistory],
    ["validation", document.validationRecords],
    ["user-source", document.userSources],
    ["activity", document.activities],
    ["hierarchy", document.hierarchy],
    ["dependency", document.dependencies],
    ["relationship-suggestion", document.relationshipSuggestions],
  ];
  const globalIds = new Map<string, string>();
  for (const [recordType, records] of groups) {
    const local = new Set<string>();
    for (const record of records) {
      if (local.has(record.portableId)) {
        add(
          recordType,
          record.portableId,
          "invalid",
          "Duplicate stable identifier.",
        );
      }
      local.add(record.portableId);
      const prior = globalIds.get(record.portableId);
      if (prior && prior !== recordType) {
        add(
          recordType,
          record.portableId,
          "invalid",
          `Stable identifier is already used by a ${prior} record.`,
        );
      } else {
        globalIds.set(record.portableId, recordType);
      }
    }
  }

  const projectIds = new Set([
    ...current.projects.map((item) => item.portableId),
    ...document.projects.map((item) => item.portableId),
  ]);
  const repositoryIds = new Set([
    ...current.repositories.map((item) => item.portableId),
    ...document.repositories.map((item) => item.portableId),
  ]);
  const worktreeIds = new Set([
    ...current.worktrees.map((item) => item.portableId),
    ...document.worktrees.map((item) => item.portableId),
  ]);
  const actionableIds = new Set([
    ...current.actionables.map((item) => item.portableId),
    ...document.actionables.map((item) => item.portableId),
  ]);
  const validationIds = new Set([
    ...current.validationRecords.map((item) => item.portableId),
    ...document.validationRecords.map((item) => item.portableId),
  ]);
  for (const repository of document.repositories) {
    if (!projectIds.has(repository.projectId)) {
      add(
        "repository",
        repository.portableId,
        "missing-reference",
        `Project ${repository.projectId} does not exist.`,
      );
    }
  }
  for (const worktree of document.worktrees) {
    if (!projectIds.has(worktree.projectId)) {
      add(
        "worktree",
        worktree.portableId,
        "missing-reference",
        `Project ${worktree.projectId} does not exist.`,
      );
    }
    if (!repositoryIds.has(worktree.repositoryId)) {
      add(
        "worktree",
        worktree.portableId,
        "missing-reference",
        `Repository ${worktree.repositoryId} does not exist.`,
      );
    }
  }
  for (const actionable of document.actionables) {
    if (!projectIds.has(actionable.projectId))
      add(
        "actionable",
        actionable.portableId,
        "missing-reference",
        `Project ${actionable.projectId} does not exist.`,
      );
    if (!repositoryIds.has(actionable.repositoryId))
      add(
        "actionable",
        actionable.portableId,
        "missing-reference",
        `Repository ${actionable.repositoryId} does not exist.`,
      );
    if (!worktreeIds.has(actionable.worktreeId))
      add(
        "actionable",
        actionable.portableId,
        "missing-reference",
        `Worktree ${actionable.worktreeId} does not exist.`,
      );
  }
  const projectById = new Map(
    [...current.projects, ...document.projects].map((item) => [
      item.portableId,
      item,
    ]),
  );
  const repositoryById = new Map(
    [...current.repositories, ...document.repositories].map((item) => [
      item.portableId,
      item,
    ]),
  );
  const worktreeById = new Map(
    [...current.worktrees, ...document.worktrees].map((item) => [
      item.portableId,
      item,
    ]),
  );
  const expectedInherited = (
    projectId: string,
    repositoryId?: string,
    worktreeId?: string,
  ) => [
    ...(projectById.get(projectId)?.archive.directArchivedAt
      ? ["project" as const]
      : []),
    ...(repositoryId &&
    repositoryById.get(repositoryId)?.archive.directArchivedAt
      ? ["repository" as const]
      : []),
    ...(worktreeId && worktreeById.get(worktreeId)?.archive.directArchivedAt
      ? ["worktree" as const]
      : []),
  ];
  for (const project of document.projects) {
    if (project.archive.inheritedFrom.length) {
      add(
        "project",
        project.portableId,
        "invalid",
        "Projects cannot inherit archive state.",
      );
    }
  }
  for (const repository of document.repositories) {
    if (
      !same(
        repository.archive.inheritedFrom,
        expectedInherited(repository.projectId),
      )
    ) {
      add(
        "repository",
        repository.portableId,
        "invalid",
        "Inherited archive state does not match its project.",
      );
    }
  }
  for (const worktree of document.worktrees) {
    if (
      !same(
        worktree.archive.inheritedFrom,
        expectedInherited(worktree.projectId, worktree.repositoryId),
      )
    ) {
      add(
        "worktree",
        worktree.portableId,
        "invalid",
        "Inherited archive state does not match its project and repository.",
      );
    }
  }
  for (const actionable of document.actionables) {
    if (
      !same(
        actionable.archive.inheritedFrom,
        expectedInherited(
          actionable.projectId,
          actionable.repositoryId,
          actionable.worktreeId,
        ),
      )
    ) {
      add(
        "actionable",
        actionable.portableId,
        "invalid",
        "Inherited archive state does not match its scope.",
      );
    }
  }
  const childReferences: ReadonlyArray<readonly [RecordType, string, string]> =
    [
      ...document.statusHistory.map(
        (item) =>
          ["status-history", item.portableId, item.actionableId] as const,
      ),
      ...document.validationRecords.map(
        (item) => ["validation", item.portableId, item.actionableId] as const,
      ),
      ...document.userSources.map(
        (item) => ["user-source", item.portableId, item.actionableId] as const,
      ),
      ...document.activities.map(
        (item) => ["activity", item.portableId, item.actionableId] as const,
      ),
    ];
  for (const [recordType, portableId, actionableId] of childReferences) {
    if (!actionableIds.has(actionableId))
      add(
        recordType,
        portableId,
        "missing-reference",
        `Actionable ${actionableId} does not exist.`,
      );
  }
  for (const record of document.validationRecords) {
    if (record.supersedesId && !validationIds.has(record.supersedesId)) {
      add(
        "validation",
        record.portableId,
        "missing-reference",
        `Superseded validation ${record.supersedesId} does not exist.`,
      );
    }
    if (record.supersedesId === record.portableId) {
      add(
        "validation",
        record.portableId,
        "integrity-failure",
        "A validation cannot supersede itself.",
      );
    }
  }
  const historiesById = new Map(
    [...current.statusHistory, ...document.statusHistory].map((item) => [
      item.portableId,
      item,
    ]),
  );
  const validationsById = new Map(
    [...current.validationRecords, ...document.validationRecords].map(
      (item) => [item.portableId, item],
    ),
  );
  const supersededTargets = new Map<string, string>();
  for (const record of validationsById.values()) {
    if (!record.supersedesId) continue;
    const prior = supersededTargets.get(record.supersedesId);
    if (prior && prior !== record.portableId) {
      add(
        "validation",
        record.portableId,
        "integrity-failure",
        "A validation record can be superseded only once.",
      );
    }
    supersededTargets.set(record.supersedesId, record.portableId);
    const visited = new Set<string>([record.portableId]);
    let next: string | null = record.supersedesId;
    while (next) {
      if (visited.has(next)) {
        add(
          "validation",
          record.portableId,
          "integrity-failure",
          "The validation supersession chain contains a cycle.",
        );
        break;
      }
      visited.add(next);
      next = validationsById.get(next)?.supersedesId ?? null;
    }
  }
  for (const actionable of document.actionables) {
    if (
      actionable.status === "Ready" &&
      (!actionable.finding.trim() ||
        !actionable.description.trim() ||
        actionable.validation.length === 0)
    ) {
      add(
        "actionable",
        actionable.portableId,
        "integrity-failure",
        "Ready requires a finding, description, and validation plan.",
      );
    }
    if (actionable.status === "Blocked" && !actionable.manualBlocker?.trim()) {
      add(
        "actionable",
        actionable.portableId,
        "integrity-failure",
        "Blocked requires a manual blocker note.",
      );
    }
    if (
      actionable.status === "Dismissed" &&
      !actionable.dismissalReason?.trim()
    ) {
      add(
        "actionable",
        actionable.portableId,
        "integrity-failure",
        "Dismissed requires a reason.",
      );
    }
    const histories = document.statusHistory
      .filter((entry) => entry.actionableId === actionable.portableId)
      .sort(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) ||
          left.portableId.localeCompare(right.portableId),
      );
    if (
      histories.length &&
      histories[histories.length - 1]!.newStatus !== actionable.status
    ) {
      add(
        "actionable",
        actionable.portableId,
        "integrity-failure",
        "Lifecycle status does not match the latest status-history record.",
      );
    }
    if (
      histories.length === 0 &&
      !current.actionables.some(
        (item) => item.portableId === actionable.portableId,
      ) &&
      actionable.status !== "Inbox"
    ) {
      add(
        "actionable",
        actionable.portableId,
        "integrity-failure",
        "A new non-Inbox actionable requires lifecycle history.",
      );
    }
    if (
      actionable.status === "Done" &&
      !actionable.completionOverride?.trim()
    ) {
      const latestInProgress = [...historiesById.values()]
        .filter((entry) => entry.actionableId === actionable.portableId)
        .filter((entry) => entry.newStatus === "In progress")
        .sort(
          (left, right) =>
            left.occurredAt.localeCompare(right.occurredAt) ||
            left.portableId.localeCompare(right.portableId),
        )
        .at(-1)?.occurredAt;
      const qualifying = [...validationsById.values()].some(
        (record) =>
          record.actionableId === actionable.portableId &&
          record.outcome === "Passed" &&
          !supersededTargets.has(record.portableId) &&
          Boolean(latestInProgress) &&
          record.recordedAt >= latestInProgress!,
      );
      if (!qualifying) {
        add(
          "actionable",
          actionable.portableId,
          "integrity-failure",
          "Done requires a current passed validation after In progress or a completion override.",
        );
      }
    }
  }
  const actionById = new Map(
    [...current.actionables, ...document.actionables].map((item) => [
      item.portableId,
      item,
    ]),
  );
  const activeHierarchy = [
    ...current.hierarchy.filter((item) => item.detachedAt === null),
    ...document.hierarchy.filter((item) => item.detachedAt === null),
  ];
  const parentByChild = new Map<string, string>();
  const children = new Set<string>();
  const parents = new Set<string>();
  const hierarchyPairs = new Set<string>();
  const incomingHierarchyIds = new Set(
    document.hierarchy
      .filter((item) => item.detachedAt === null)
      .map((item) => item.portableId),
  );
  for (const relationship of activeHierarchy) {
    if (
      !actionableIds.has(relationship.parentId) ||
      !actionableIds.has(relationship.childId)
    ) {
      add(
        "hierarchy",
        relationship.portableId,
        "missing-reference",
        "Hierarchy endpoints must exist.",
      );
      continue;
    }
    if (relationship.parentId === relationship.childId) {
      add(
        "hierarchy",
        relationship.portableId,
        "integrity-failure",
        "Self hierarchy is not allowed.",
      );
    }
    const pair = `${relationship.parentId}|${relationship.childId}`;
    if (
      hierarchyPairs.has(pair) &&
      incomingHierarchyIds.has(relationship.portableId)
    ) {
      const duplicateInDocument =
        document.hierarchy.filter(
          (item) =>
            item.detachedAt === null &&
            item.parentId === relationship.parentId &&
            item.childId === relationship.childId,
        ).length > 1;
      if (duplicateInDocument)
        add(
          "hierarchy",
          relationship.portableId,
          "integrity-failure",
          "Duplicate active hierarchy relationship.",
        );
    }
    hierarchyPairs.add(pair);
    const prior = parentByChild.get(relationship.childId);
    if (prior && prior !== relationship.parentId) {
      add(
        "hierarchy",
        relationship.portableId,
        "integrity-failure",
        "A child may have only one active parent.",
      );
    }
    parentByChild.set(relationship.childId, relationship.parentId);
    parents.add(relationship.parentId);
    children.add(relationship.childId);
    const parent = actionById.get(relationship.parentId);
    const child = actionById.get(relationship.childId);
    if (
      parent &&
      child &&
      (parent.projectId !== child.projectId ||
        parent.repositoryId !== child.repositoryId ||
        parent.worktreeId !== child.worktreeId)
    ) {
      add(
        "hierarchy",
        relationship.portableId,
        "integrity-failure",
        "Hierarchy cannot cross project, repository, or worktree scope.",
      );
    }
  }
  for (const id of parents) {
    if (children.has(id)) {
      add(
        "hierarchy",
        id,
        "integrity-failure",
        "Only one hierarchy level is supported.",
      );
    }
  }
  for (const relationship of activeHierarchy) {
    const parent = actionById.get(relationship.parentId);
    const child = actionById.get(relationship.childId);
    if (
      parent?.status === "Done" &&
      child &&
      !["Done", "Dismissed"].includes(child.status)
    ) {
      add(
        "hierarchy",
        relationship.portableId,
        "integrity-failure",
        "A completed parent cannot have a nonterminal active child.",
      );
    }
  }

  const activeDependencies = [
    ...current.dependencies.filter((item) => item.removedAt === null),
    ...document.dependencies.filter((item) => item.removedAt === null),
  ];
  const dependencyPairs = new Set<string>();
  const incomingDependencyIds = new Set(
    document.dependencies
      .filter((item) => item.removedAt === null)
      .map((item) => item.portableId),
  );
  const outgoing = new Map<string, string[]>();
  for (const relationship of activeDependencies) {
    if (
      !actionableIds.has(relationship.dependentId) ||
      !actionableIds.has(relationship.prerequisiteId)
    ) {
      add(
        "dependency",
        relationship.portableId,
        "missing-reference",
        "Dependency endpoints must exist.",
      );
      continue;
    }
    if (relationship.dependentId === relationship.prerequisiteId) {
      add(
        "dependency",
        relationship.portableId,
        "integrity-failure",
        "Self dependency is not allowed.",
      );
    }
    const pair = `${relationship.dependentId}|${relationship.prerequisiteId}`;
    if (
      dependencyPairs.has(pair) &&
      incomingDependencyIds.has(relationship.portableId)
    ) {
      const duplicateInDocument =
        document.dependencies.filter(
          (item) =>
            item.removedAt === null &&
            item.dependentId === relationship.dependentId &&
            item.prerequisiteId === relationship.prerequisiteId,
        ).length > 1;
      if (duplicateInDocument)
        add(
          "dependency",
          relationship.portableId,
          "integrity-failure",
          "Duplicate active dependency relationship.",
        );
    }
    dependencyPairs.add(pair);
    const values = outgoing.get(relationship.dependentId) ?? [];
    values.push(relationship.prerequisiteId);
    outgoing.set(relationship.dependentId, values);
  }
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of outgoing.get(id) ?? []) {
      if (visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const id of actionableIds) {
    if (visit(id)) {
      add(
        "dependency",
        id,
        "integrity-failure",
        "The dependency graph contains a cycle.",
      );
      break;
    }
  }
  for (const suggestion of document.relationshipSuggestions) {
    if (
      !actionableIds.has(suggestion.fromId) ||
      !actionableIds.has(suggestion.toId)
    ) {
      add(
        "relationship-suggestion",
        suggestion.portableId,
        "missing-reference",
        "Suggestion endpoints must exist.",
      );
    }
    if (suggestion.fromId === suggestion.toId) {
      add(
        "relationship-suggestion",
        suggestion.portableId,
        "integrity-failure",
        "Self relationship suggestions are not allowed.",
      );
    }
  }
  return issues;
}

function currentChildMaps(document: PortableDocument) {
  return {
    "status-history": new Map(
      document.statusHistory.map((item) => [item.portableId, item]),
    ),
    validation: new Map(
      document.validationRecords.map((item) => [item.portableId, item]),
    ),
    "user-source": new Map(
      document.userSources.map((item) => [item.portableId, item]),
    ),
    activity: new Map(
      document.activities.map((item) => [item.portableId, item]),
    ),
    hierarchy: new Map(
      document.hierarchy.map((item) => [item.portableId, item]),
    ),
    dependency: new Map(
      document.dependencies.map((item) => [item.portableId, item]),
    ),
  };
}

async function analyze(
  client: Client,
  document: PortableDocument,
): Promise<Analysis> {
  const current = await exportPortableDocument(client as AppPrismaClient, {
    exportedAt: new Date(0),
    sourceName: null,
  });
  const [projectRows, repositoryRows, worktreeRows, actionableRows] =
    await Promise.all([
      client.project.findMany(),
      client.repository.findMany(),
      client.worktree.findMany(),
      client.actionable.findMany(),
    ]);
  const projectRow = new Map(
    projectRows.map((item) => [item.externalKey, item]),
  );
  const repositoryRow = new Map(
    repositoryRows.map((item) => [item.externalKey, item]),
  );
  const worktreeRow = new Map(
    worktreeRows.map((item) => [item.externalKey, item]),
  );
  const actionableRow = new Map(
    actionableRows.map((item) => [item.externalKey, item]),
  );
  const currentProjects = new Map(
    current.projects.map((item) => [item.portableId, item]),
  );
  const currentRepositories = new Map(
    current.repositories.map((item) => [item.portableId, item]),
  );
  const currentWorktrees = new Map(
    current.worktrees.map((item) => [item.portableId, item]),
  );
  const currentActions = new Map(
    current.actionables.map((item) => [item.portableId, item]),
  );
  const items: ImportPreviewItem[] = [];
  const plans: MutationPlan[] = [];
  const totals = emptyCount();
  const totalsByRecordType: Record<string, Count> = {};

  for (const issue of integrityItems(document, current)) {
    addItem(items, totals, totalsByRecordType, issue);
  }

  const addPlan = (item: ImportPreviewItem, plan: MutationPlan) => {
    addItem(items, totals, totalsByRecordType, item);
    plans.push(plan);
  };
  for (const project of document.projects) {
    const existing = currentProjects.get(project.portableId);
    if (!existing) {
      addPlan(
        {
          id: `project:${project.portableId}`,
          recordType: "project",
          portableId: project.portableId,
          display: project.name,
          classification: "create",
          changes: [],
          errors: [],
        },
        {
          recordType: "project",
          portableId: project.portableId,
          classification: "create",
          safeFields: [],
        },
      );
      continue;
    }
    const compared = compareFields(
      "project",
      project.portableId,
      project.name,
      { name: existing.name, archive: directArchive(existing.archive) },
      { name: project.name, archive: directArchive(project.archive) },
      baselineObject(projectRow.get(project.portableId)?.importBaselineJson),
    );
    addPlan(compared.item, compared.plan);
  }
  for (const repository of document.repositories) {
    const existing = currentRepositories.get(repository.portableId);
    if (!existing) {
      addPlan(
        {
          id: `repository:${repository.portableId}`,
          recordType: "repository",
          portableId: repository.portableId,
          display: repository.name,
          classification: "create",
          changes: [],
          errors: [],
        },
        {
          recordType: "repository",
          portableId: repository.portableId,
          classification: "create",
          safeFields: [],
        },
      );
      continue;
    }
    const compared = compareFields(
      "repository",
      repository.portableId,
      repository.name,
      {
        projectId: existing.projectId,
        name: existing.name,
        localPath: existing.localPath,
        archive: directArchive(existing.archive),
      },
      {
        projectId: repository.projectId,
        name: repository.name,
        localPath: repository.localPath,
        archive: directArchive(repository.archive),
      },
      baselineObject(
        repositoryRow.get(repository.portableId)?.importBaselineJson,
      ),
    );
    addPlan(compared.item, compared.plan);
  }
  for (const worktree of document.worktrees) {
    const existing = currentWorktrees.get(worktree.portableId);
    if (!existing) {
      addPlan(
        {
          id: `worktree:${worktree.portableId}`,
          recordType: "worktree",
          portableId: worktree.portableId,
          display: worktree.name,
          classification: "create",
          changes: [],
          errors: [],
        },
        {
          recordType: "worktree",
          portableId: worktree.portableId,
          classification: "create",
          safeFields: [],
        },
      );
      continue;
    }
    const compared = compareFields(
      "worktree",
      worktree.portableId,
      worktree.name,
      {
        projectId: existing.projectId,
        repositoryId: existing.repositoryId,
        name: existing.name,
        localPath: existing.localPath,
        archive: directArchive(existing.archive),
      },
      {
        projectId: worktree.projectId,
        repositoryId: worktree.repositoryId,
        name: worktree.name,
        localPath: worktree.localPath,
        archive: directArchive(worktree.archive),
      },
      baselineObject(worktreeRow.get(worktree.portableId)?.importBaselineJson),
    );
    addPlan(compared.item, compared.plan);
  }
  for (const actionable of document.actionables) {
    const existing = currentActions.get(actionable.portableId);
    if (!existing) {
      addPlan(
        {
          id: `actionable:${actionable.portableId}`,
          recordType: "actionable",
          portableId: actionable.portableId,
          display: actionable.title,
          classification: "create",
          changes: [],
          errors: [],
        },
        {
          recordType: "actionable",
          portableId: actionable.portableId,
          classification: "create",
          safeFields: [],
        },
      );
      continue;
    }
    const row = actionableRow.get(actionable.portableId);
    let baseline = baselineObject(row?.importBaselineJson);
    if (!Object.keys(baseline).length && row) {
      baseline =
        legacySeedBaseline(row.rawFragmentJson, actionable) ?? baseline;
    }
    const compared = compareFields(
      "actionable",
      actionable.portableId,
      actionable.title,
      currentActionFields(existing),
      fieldObject(actionable),
      baseline,
    );
    if (
      compared.plan.safeFields.includes("status") &&
      !document.statusHistory.some(
        (entry) => entry.actionableId === actionable.portableId,
      )
    ) {
      addItem(items, totals, totalsByRecordType, {
        id: `integrity-failure:actionable:${actionable.portableId}:status-history`,
        recordType: "actionable",
        portableId: actionable.portableId,
        display: actionable.title,
        classification: "integrity-failure",
        changes: [],
        errors: [
          "A safe lifecycle status update requires matching portable status history.",
        ],
      });
    }
    addPlan(compared.item, compared.plan);
  }

  const childMaps = currentChildMaps(current);
  const childGroups: Array<
    [
      Exclude<
        RecordType,
        | "project"
        | "repository"
        | "worktree"
        | "actionable"
        | "relationship-suggestion"
      >,
      Array<Record<string, unknown> & { portableId: string }>,
    ]
  > = [
    ["status-history", document.statusHistory],
    ["validation", document.validationRecords],
    ["user-source", document.userSources],
    ["activity", document.activities],
    ["hierarchy", document.hierarchy],
    ["dependency", document.dependencies],
  ];
  for (const [recordType, records] of childGroups) {
    const currentMap = childMaps[recordType] as Map<string, unknown>;
    for (const record of records) {
      let existing = currentMap.get(record.portableId);
      if (!existing && recordType === "hierarchy") {
        existing = current.hierarchy.find(
          (item) =>
            item.parentId === record.parentId &&
            item.childId === record.childId &&
            item.detachedAt === record.detachedAt,
        );
      }
      if (!existing && recordType === "dependency") {
        existing = current.dependencies.find(
          (item) =>
            item.dependentId === record.dependentId &&
            item.prerequisiteId === record.prerequisiteId &&
            item.removedAt === record.removedAt,
        );
      }
      const classification = existing
        ? same(
            genericComparable(existing as Record<string, unknown>),
            genericComparable(record),
          )
          ? "no-op"
          : recordType === "hierarchy" || recordType === "dependency"
            ? same(
                genericComparable({
                  ...(existing as Record<string, unknown>),
                  portableId: record.portableId,
                }),
                genericComparable(record),
              )
              ? "no-op"
              : "conflict"
            : "conflict"
        : "create";
      const item: ImportPreviewItem = {
        id: `${recordType}:${record.portableId}`,
        recordType,
        portableId: record.portableId,
        display: record.portableId,
        classification,
        changes:
          classification === "conflict"
            ? [
                {
                  field: "record",
                  current: existing,
                  incoming: record,
                  reason:
                    "Conflict: immutable history or relationship data differs.",
                },
              ]
            : [],
        errors: [],
      };
      addPlan(item, {
        recordType,
        portableId: record.portableId,
        classification,
        safeFields: [],
      });
    }
  }
  for (const suggestion of document.relationshipSuggestions) {
    const represented =
      suggestion.kind === "hierarchy"
        ? [...current.hierarchy, ...document.hierarchy].some(
            (relationship) =>
              relationship.detachedAt === null &&
              relationship.parentId === suggestion.fromId &&
              relationship.childId === suggestion.toId,
          )
        : [...current.dependencies, ...document.dependencies].some(
            (relationship) =>
              relationship.removedAt === null &&
              relationship.dependentId === suggestion.fromId &&
              relationship.prerequisiteId === suggestion.toId,
          );
    if (represented) {
      addPlan(
        {
          id: `relationship-suggestion:${suggestion.portableId}`,
          recordType: "relationship-suggestion",
          portableId: suggestion.portableId,
          display: suggestion.reason,
          classification: "no-op",
          changes: [
            {
              field: suggestion.kind,
              incoming: { fromId: suggestion.fromId, toId: suggestion.toId },
              reason:
                "The suggested relationship is already represented explicitly.",
            },
          ],
          errors: [],
        },
        {
          recordType: "relationship-suggestion",
          portableId: suggestion.portableId,
          classification: "no-op",
          safeFields: [],
        },
      );
      continue;
    }
    addPlan(
      {
        id: `relationship-suggestion:${suggestion.portableId}`,
        recordType: "relationship-suggestion",
        portableId: suggestion.portableId,
        display: suggestion.reason,
        classification: "suggestion",
        changes: [
          {
            field: suggestion.kind,
            incoming: { fromId: suggestion.fromId, toId: suggestion.toId },
            reason:
              "Inferred relationship; confirmation is required before it becomes a domain fact.",
          },
        ],
        errors: [],
      },
      {
        recordType: "relationship-suggestion",
        portableId: suggestion.portableId,
        classification: "suggestion",
        safeFields: [],
      },
    );
  }

  const blocked =
    totals.invalid + totals.missingReferences + totals.integrityFailures > 0;
  const archiveEffects = document.actionables
    .filter((item) => item.archive.directArchivedAt)
    .map((item) => `${item.portableId} will be directly archived.`);
  const lifecycleEffects = document.actionables
    .filter((item) => item.status !== "Inbox")
    .map(
      (item) =>
        `${item.portableId} will restore lifecycle status ${item.status}.`,
    );
  return {
    plans,
    response: {
      contentDigest: sha256(document),
      schemaVersion: portableSchemaVersion,
      compatibility:
        "Schema version 1 is supported exactly. Future versions require an explicit migration.",
      canCommit: !blocked,
      items,
      totals,
      totalsByRecordType,
      archiveEffects,
      lifecycleEffects,
      affectedActionableIds: document.actionables
        .filter((item) => {
          const plan = plans.find(
            (candidate) =>
              candidate.recordType === "actionable" &&
              candidate.portableId === item.portableId,
          );
          return plan?.classification === "create" || plan?.safeFields.length;
        })
        .map((item) => item.portableId),
    },
  };
}

function safeData(
  item: PortableActionable,
  safeFields: string[],
  scopeIds: { projectId: string; repositoryId: string; worktreeId: string },
) {
  const requested = new Set(safeFields);
  const data: Prisma.ActionableUncheckedUpdateInput = {};
  if (requested.has("title")) data.title = item.title;
  if (requested.has("priority")) data.priority = item.priority;
  if (requested.has("status")) data.status = item.status;
  if (requested.has("statusProvenance")) {
    data.statusProvenance = item.statusProvenance.note;
    data.sourceStatusSuggestion =
      item.statusProvenance.kind === "neutral-import"
        ? (item.statusProvenance.suggestedStatus ?? null)
        : null;
  }
  if (requested.has("effort")) data.effort = item.effort;
  if (requested.has("evidenceState")) data.evidenceState = item.evidenceState;
  if (requested.has("finding")) data.finding = item.finding;
  if (requested.has("description")) data.description = item.description;
  if (requested.has("resolution")) data.resolution = item.resolution;
  if (requested.has("research")) data.researchJson = json(item.research);
  if (requested.has("validation")) data.validationJson = json(item.validation);
  if (requested.has("files")) data.filesJson = json(item.files);
  if (requested.has("tags")) data.tagsJson = json(item.tags);
  if (requested.has("manualBlocker")) data.manualBlockerMd = item.manualBlocker;
  if (requested.has("dismissalReason"))
    data.dismissalReasonMd = item.dismissalReason;
  if (requested.has("completionOverride"))
    data.completionOverrideMd = item.completionOverride;
  if (requested.has("archive"))
    data.archivedAt = item.archive.directArchivedAt
      ? new Date(item.archive.directArchivedAt)
      : null;
  if (requested.has("importedEvidence")) {
    data.importProvider = item.importedEvidence.provider;
    data.sourceContainerId = item.importedEvidence.containerId;
    data.sourceThread = item.importedEvidence.threadUrl;
    data.contentHash = item.importedEvidence.contentHash;
    data.rawFragmentJson = json(item.importedEvidence.rawFragment);
  }
  if (requested.has("projectId")) data.projectId = scopeIds.projectId;
  if (requested.has("repositoryId")) data.repositoryId = scopeIds.repositoryId;
  if (requested.has("worktreeId")) data.worktreeId = scopeIds.worktreeId;
  return data;
}

export class DataImportService {
  private readonly previews = new Map<string, StoredPreview>();
  constructor(
    private readonly prisma: AppPrismaClient,
    private readonly ttlMs = 10 * 60 * 1_000,
  ) {}

  private prune() {
    const now = Date.now();
    for (const [token, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(token);
    }
  }

  async preview(raw: unknown): Promise<ImportPreviewResponse> {
    this.prune();
    const dangerous = inspectJson(raw);
    const format =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).format
        : undefined;
    const version =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).schemaVersion
        : undefined;
    if (format !== undefined && format !== portableFormat) {
      throw new PortableImportError(
        422,
        "UNSUPPORTED_FORMAT",
        "This is not an Actionables portable document.",
      );
    }
    if (typeof version === "number" && version !== portableSchemaVersion) {
      throw new PortableImportError(
        422,
        "UNSUPPORTED_SCHEMA_VERSION",
        version > portableSchemaVersion
          ? `Schema version ${version} is newer than the supported version ${portableSchemaVersion}.`
          : `Schema version ${version} is not supported; migrate it explicitly before import.`,
      );
    }
    const parsed = portableDocumentSchema.safeParse(raw);
    let document: PortableDocument | null = null;
    let analysis: Omit<ImportPreviewResponse, "previewToken" | "expiresAt">;
    if (dangerous.length || !parsed.success) {
      const errors = [
        ...dangerous.map((message) => ({ path: "document", message })),
        ...(parsed.success
          ? []
          : parsed.error.issues.map((issue) => ({
              path: issue.path.join(".") || "document",
              message: issue.message,
            }))),
      ];
      analysis = invalidPreview(raw, errors);
    } else {
      document = normalizePortableDocument(parsed.data);
      analysis = (await analyze(this.prisma, document)).response;
    }
    const previewToken = randomUUID();
    const expiresAt = Date.now() + this.ttlMs;
    const response: ImportPreviewResponse = {
      ...analysis,
      previewToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    this.previews.set(previewToken, {
      document,
      response,
      fingerprint: await databaseFingerprint(this.prisma),
      expiresAt,
    });
    return response;
  }

  prepare(
    previewToken: string,
    input: PrepareImportCommitRequest,
  ): PrepareImportCommitResponse {
    this.prune();
    const preview = this.previews.get(previewToken);
    if (!preview || preview.expiresAt <= Date.now()) {
      throw new PortableImportError(
        409,
        "PREVIEW_EXPIRED",
        "The import preview expired. Create a new preview.",
      );
    }
    if (!preview.document || !preview.response.canCommit) {
      throw new PortableImportError(
        422,
        "PREVIEW_NOT_COMMITTABLE",
        "Resolve invalid records and integrity failures before committing.",
      );
    }
    if (input.contentDigest !== preview.response.contentDigest) {
      throw new PortableImportError(
        409,
        "DOCUMENT_CHANGED",
        "The selected document changed after preview.",
      );
    }
    const conflictIds = preview.response.items
      .filter((item) => item.classification === "conflict")
      .map((item) => item.id)
      .sort();
    const suppliedConflictIds = Object.keys(input.conflictResolutions).sort();
    if (!same(conflictIds, suppliedConflictIds)) {
      throw new PortableImportError(
        422,
        "CONFLICT_SELECTION_MISMATCH",
        "Explicitly skip every previewed conflict.",
      );
    }
    const suggestionIds = new Set(
      preview.response.items
        .filter((item) => item.classification === "suggestion")
        .map((item) => item.portableId),
    );
    if (
      new Set(input.acceptedSuggestionIds).size !==
        input.acceptedSuggestionIds.length ||
      input.acceptedSuggestionIds.some((id) => !suggestionIds.has(id))
    ) {
      throw new PortableImportError(
        422,
        "INVALID_SUGGESTION_SELECTION",
        "A relationship suggestion selection is invalid.",
      );
    }
    const selections = {
      conflictResolutions: input.conflictResolutions,
      acceptedSuggestionIds: [...input.acceptedSuggestionIds].sort(),
    };
    const selectionsDigest = sha256(selections);
    const commitToken = randomUUID();
    preview.authorization = {
      commitToken,
      selectionsDigest,
      acceptedSuggestionIds: selections.acceptedSuggestionIds,
      expiresAt: preview.expiresAt,
      consumed: false,
    };
    return {
      commitToken,
      selectionsDigest,
      expiresAt: new Date(preview.expiresAt).toISOString(),
    };
  }

  async commit(
    previewToken: string,
    input: CommitImportRequest,
  ): Promise<ImportCommitResponse> {
    this.prune();
    const preview = this.previews.get(previewToken);
    const authorization = preview?.authorization;
    if (
      !preview ||
      !preview.document ||
      !authorization ||
      preview.expiresAt <= Date.now()
    ) {
      throw new PortableImportError(
        409,
        "PREVIEW_EXPIRED",
        "The import preview is unavailable. Create a new preview.",
      );
    }
    if (authorization.consumed) {
      throw new PortableImportError(
        409,
        "COMMIT_REPLAYED",
        "This commit authorization has already been used.",
      );
    }
    if (
      input.contentDigest !== preview.response.contentDigest ||
      input.commitToken !== authorization.commitToken ||
      input.selectionsDigest !== authorization.selectionsDigest
    ) {
      throw new PortableImportError(
        409,
        "COMMIT_AUTHORIZATION_CHANGED",
        "The document or reviewed selections changed.",
      );
    }
    authorization.consumed = true;
    const document = preview.document;
    const acceptedSuggestions = new Set(authorization.acceptedSuggestionIds);

    const result = await this.prisma.$transaction(async (transaction) => {
      if ((await databaseFingerprint(transaction)) !== preview.fingerprint) {
        throw new PortableImportError(
          409,
          "STALE_PREVIEW",
          "The database changed after preview. Create a new preview.",
        );
      }
      const analysis = await analyze(transaction, document);
      if (!analysis.response.canCommit) {
        throw new PortableImportError(
          409,
          "STALE_PREVIEW",
          "The import no longer passes validation. Create a new preview.",
        );
      }
      if (acceptedSuggestions.size) {
        const selectedDocument = structuredClone(document);
        for (const suggestion of selectedDocument.relationshipSuggestions) {
          if (!acceptedSuggestions.has(suggestion.portableId)) continue;
          if (suggestion.kind === "hierarchy") {
            selectedDocument.hierarchy.push({
              portableId: suggestion.portableId,
              parentId: suggestion.fromId,
              childId: suggestion.toId,
              createdAt: new Date().toISOString(),
              detachedAt: null,
              provenance: `confirmed suggestion: ${suggestion.provenance}`,
            });
          } else {
            selectedDocument.dependencies.push({
              portableId: suggestion.portableId,
              dependentId: suggestion.fromId,
              prerequisiteId: suggestion.toId,
              createdAt: new Date().toISOString(),
              waivedAt: null,
              waiverReason: null,
              removedAt: null,
              provenance: `confirmed suggestion: ${suggestion.provenance}`,
            });
          }
        }
        selectedDocument.relationshipSuggestions = [];
        const current = await exportPortableDocument(
          transaction as AppPrismaClient,
          {
            exportedAt: new Date(0),
            sourceName: null,
          },
        );
        const selectionIssues = integrityItems(
          selectedDocument,
          current,
        ).filter((item) => acceptedSuggestions.has(item.portableId));
        if (selectionIssues.length) {
          throw new PortableImportError(
            422,
            "INVALID_CONFIRMED_SUGGESTION",
            selectionIssues[0]!.errors[0] ??
              "A confirmed relationship suggestion is invalid.",
          );
        }
      }
      const plan = new Map(
        analysis.plans.map((item) => [
          `${item.recordType}:${item.portableId}`,
          item,
        ]),
      );
      const projectIds = new Map<string, string>();
      const repositoryIds = new Map<string, string>();
      const worktreeIds = new Map<string, string>();

      for (const item of document.projects) {
        const operation = plan.get(`project:${item.portableId}`)!;
        const baseline = {
          name: item.name,
          archive: directArchive(item.archive),
        };
        const existing = await transaction.project.findUnique({
          where: { externalKey: item.portableId },
        });
        if (!existing) {
          const created = await transaction.project.create({
            data: {
              externalKey: item.portableId,
              name: item.name,
              archivedAt: item.archive.directArchivedAt
                ? new Date(item.archive.directArchivedAt)
                : null,
              importBaselineJson: json(baseline),
              ...(item.createdAt
                ? { createdAt: new Date(item.createdAt) }
                : {}),
              ...(item.updatedAt
                ? { updatedAt: new Date(item.updatedAt) }
                : {}),
            },
          });
          projectIds.set(item.portableId, created.id);
        } else {
          const data: Prisma.ProjectUpdateInput = {};
          if (operation.safeFields.includes("name")) data.name = item.name;
          if (operation.safeFields.includes("archive"))
            data.archivedAt = item.archive.directArchivedAt
              ? new Date(item.archive.directArchivedAt)
              : null;
          if (operation.safeFields.length || !existing.importBaselineJson)
            data.importBaselineJson = json(operation.nextBaseline ?? baseline);
          if (Object.keys(data).length) {
            data.version = { increment: operation.safeFields.length ? 1 : 0 };
            await transaction.project.update({
              where: { id: existing.id },
              data,
            });
          }
          projectIds.set(item.portableId, existing.id);
        }
      }
      for (const item of document.repositories) {
        const operation = plan.get(`repository:${item.portableId}`)!;
        const projectId =
          projectIds.get(item.projectId) ??
          (
            await transaction.project.findUniqueOrThrow({
              where: { externalKey: item.projectId },
            })
          ).id;
        const baseline = {
          projectId: item.projectId,
          name: item.name,
          localPath: item.localPath,
          archive: directArchive(item.archive),
        };
        const existing = await transaction.repository.findUnique({
          where: { externalKey: item.portableId },
        });
        if (!existing) {
          const created = await transaction.repository.create({
            data: {
              externalKey: item.portableId,
              projectId,
              name: item.name,
              localPath: item.localPath,
              archivedAt: item.archive.directArchivedAt
                ? new Date(item.archive.directArchivedAt)
                : null,
              importBaselineJson: json(baseline),
              ...(item.createdAt
                ? { createdAt: new Date(item.createdAt) }
                : {}),
              ...(item.updatedAt
                ? { updatedAt: new Date(item.updatedAt) }
                : {}),
            },
          });
          repositoryIds.set(item.portableId, created.id);
        } else {
          const data: Prisma.RepositoryUpdateInput = {};
          if (operation.safeFields.includes("projectId"))
            data.project = { connect: { id: projectId } };
          if (operation.safeFields.includes("name")) data.name = item.name;
          if (operation.safeFields.includes("localPath"))
            data.localPath = item.localPath;
          if (operation.safeFields.includes("archive"))
            data.archivedAt = item.archive.directArchivedAt
              ? new Date(item.archive.directArchivedAt)
              : null;
          if (operation.safeFields.length || !existing.importBaselineJson)
            data.importBaselineJson = json(operation.nextBaseline ?? baseline);
          if (Object.keys(data).length) {
            data.version = { increment: operation.safeFields.length ? 1 : 0 };
            await transaction.repository.update({
              where: { id: existing.id },
              data,
            });
          }
          repositoryIds.set(item.portableId, existing.id);
        }
      }
      for (const item of document.worktrees) {
        const operation = plan.get(`worktree:${item.portableId}`)!;
        const projectId =
          projectIds.get(item.projectId) ??
          (
            await transaction.project.findUniqueOrThrow({
              where: { externalKey: item.projectId },
            })
          ).id;
        const repositoryId =
          repositoryIds.get(item.repositoryId) ??
          (
            await transaction.repository.findUniqueOrThrow({
              where: { externalKey: item.repositoryId },
            })
          ).id;
        const baseline = {
          projectId: item.projectId,
          repositoryId: item.repositoryId,
          name: item.name,
          localPath: item.localPath,
          archive: directArchive(item.archive),
        };
        const existing = await transaction.worktree.findUnique({
          where: { externalKey: item.portableId },
        });
        if (!existing) {
          const created = await transaction.worktree.create({
            data: {
              externalKey: item.portableId,
              projectId,
              repositoryId,
              name: item.name,
              localPath: item.localPath,
              archivedAt: item.archive.directArchivedAt
                ? new Date(item.archive.directArchivedAt)
                : null,
              importBaselineJson: json(baseline),
              ...(item.createdAt
                ? { createdAt: new Date(item.createdAt) }
                : {}),
              ...(item.updatedAt
                ? { updatedAt: new Date(item.updatedAt) }
                : {}),
            },
          });
          worktreeIds.set(item.portableId, created.id);
        } else {
          const data: Prisma.WorktreeUpdateInput = {};
          if (operation.safeFields.includes("projectId"))
            data.project = { connect: { id: projectId } };
          if (operation.safeFields.includes("repositoryId"))
            data.repository = { connect: { id: repositoryId } };
          if (operation.safeFields.includes("name")) data.name = item.name;
          if (operation.safeFields.includes("localPath"))
            data.localPath = item.localPath;
          if (operation.safeFields.includes("archive"))
            data.archivedAt = item.archive.directArchivedAt
              ? new Date(item.archive.directArchivedAt)
              : null;
          if (operation.safeFields.length || !existing.importBaselineJson)
            data.importBaselineJson = json(operation.nextBaseline ?? baseline);
          if (Object.keys(data).length) {
            data.version = { increment: operation.safeFields.length ? 1 : 0 };
            await transaction.worktree.update({
              where: { id: existing.id },
              data,
            });
          }
          worktreeIds.set(item.portableId, existing.id);
        }
      }

      let nextOrdinal =
        (
          await transaction.actionable.aggregate({
            _max: { sourceOrdinal: true },
          })
        )._max.sourceOrdinal ?? 0;
      const actionableIds = new Map<string, { id: string; ordinal: number }>();
      for (const item of document.actionables) {
        const operation = plan.get(`actionable:${item.portableId}`)!;
        const projectId =
          projectIds.get(item.projectId) ??
          (
            await transaction.project.findUniqueOrThrow({
              where: { externalKey: item.projectId },
            })
          ).id;
        const repositoryId =
          repositoryIds.get(item.repositoryId) ??
          (
            await transaction.repository.findUniqueOrThrow({
              where: { externalKey: item.repositoryId },
            })
          ).id;
        const worktreeId =
          worktreeIds.get(item.worktreeId) ??
          (
            await transaction.worktree.findUniqueOrThrow({
              where: { externalKey: item.worktreeId },
            })
          ).id;
        const existing = await transaction.actionable.findUnique({
          where: { externalKey: item.portableId },
        });
        if (!existing) {
          nextOrdinal += 1;
          const hasHistory = document.statusHistory.some(
            (entry) => entry.actionableId === item.portableId,
          );
          const hasActivity = document.activities.some(
            (entry) => entry.actionableId === item.portableId,
          );
          const created = await transaction.actionable.create({
            data: {
              externalKey: item.portableId,
              sourceOrdinal: nextOrdinal,
              title: item.title,
              priority: item.priority,
              status: item.status,
              statusProvenance: item.statusProvenance.note,
              sourceStatusSuggestion:
                item.statusProvenance.kind === "neutral-import"
                  ? (item.statusProvenance.suggestedStatus ?? null)
                  : null,
              effort: item.effort,
              evidenceState: item.evidenceState,
              archivedAt: item.archive.directArchivedAt
                ? new Date(item.archive.directArchivedAt)
                : null,
              updatedLabel: "imported",
              manualBlockerMd: item.manualBlocker,
              dismissalReasonMd: item.dismissalReason,
              completionOverrideMd: item.completionOverride,
              finding: item.finding,
              description: item.description,
              resolution: item.resolution,
              researchJson: json(item.research),
              validationJson: json(item.validation),
              filesJson: json(item.files),
              tagsJson: json(item.tags),
              userSourcesJson: json([]),
              blockedByOrdinalsJson: json([]),
              blocksOrdinalsJson: json([]),
              childOrdinalsJson: json([]),
              importProvider: item.importedEvidence.provider,
              sourceContainerId: item.importedEvidence.containerId,
              sourceThread: item.importedEvidence.threadUrl,
              contentHash: item.importedEvidence.contentHash,
              rawFragmentJson: json(item.importedEvidence.rawFragment),
              importBaselineJson: json(fieldObject(item)),
              fieldOwnershipJson: json(item.provenance.fieldOwnership),
              projectId,
              repositoryId,
              worktreeId,
              ...(item.createdAt
                ? { createdAt: new Date(item.createdAt) }
                : {}),
              ...(item.updatedAt
                ? { updatedAt: new Date(item.updatedAt) }
                : {}),
              ...(!hasHistory
                ? {
                    statusHistory: {
                      create: {
                        previousStatus: null,
                        newStatus: item.status,
                        origin: "portable-import",
                      },
                    },
                  }
                : {}),
              ...(!hasActivity
                ? {
                    activityEvents: {
                      create: {
                        type: "status-transition",
                        summary: `Imported as ${item.status}`,
                        metadataJson: json({
                          previousStatus: "",
                          newStatus: item.status,
                          origin: "portable-import",
                        }),
                      },
                    },
                  }
                : {}),
            },
          });
          actionableIds.set(item.portableId, {
            id: created.id,
            ordinal: created.sourceOrdinal,
          });
        } else {
          const data = safeData(item, operation.safeFields, {
            projectId,
            repositoryId,
            worktreeId,
          });
          if (operation.safeFields.length) {
            data.version = { increment: 1 };
            data.updatedLabel = "imported";
          }
          if (operation.safeFields.length || !existing.importBaselineJson)
            data.importBaselineJson = json(
              operation.nextBaseline ?? fieldObject(item),
            );
          if (!existing.fieldOwnershipJson)
            data.fieldOwnershipJson = json(item.provenance.fieldOwnership);
          if (Object.keys(data).length)
            await transaction.actionable.update({
              where: { id: existing.id },
              data,
            });
          actionableIds.set(item.portableId, {
            id: existing.id,
            ordinal: existing.sourceOrdinal,
          });
        }
      }
      for (const item of await transaction.actionable.findMany({
        select: { id: true, externalKey: true, sourceOrdinal: true },
      })) {
        actionableIds.set(item.externalKey, {
          id: item.id,
          ordinal: item.sourceOrdinal,
        });
      }

      for (const record of document.statusHistory) {
        if (
          plan.get(`status-history:${record.portableId}`)?.classification !==
          "create"
        )
          continue;
        await transaction.actionableStatusHistory.create({
          data: {
            id: record.portableId,
            actionableId: actionableIds.get(record.actionableId)!.id,
            previousStatus: record.previousStatus,
            newStatus: record.newStatus,
            origin: record.origin,
            occurredAt: new Date(record.occurredAt),
          },
        });
      }
      const pendingValidations = document.validationRecords.filter(
        (record) =>
          plan.get(`validation:${record.portableId}`)?.classification ===
          "create",
      );
      while (pendingValidations.length) {
        let inserted = false;
        for (let index = 0; index < pendingValidations.length; index += 1) {
          const record = pendingValidations[index]!;
          if (
            record.supersedesId &&
            !(await transaction.validationRecord.findUnique({
              where: { id: record.supersedesId },
              select: { id: true },
            }))
          ) {
            continue;
          }
          await transaction.validationRecord.create({
            data: {
              id: record.portableId,
              actionableId: actionableIds.get(record.actionableId)!.id,
              type: record.type,
              outcome: record.outcome,
              notesMd: record.notes,
              evidenceMd: record.evidence,
              origin: record.origin,
              recordedAt: new Date(record.recordedAt),
              supersedesId: record.supersedesId,
            },
          });
          pendingValidations.splice(index, 1);
          inserted = true;
          break;
        }
        if (!inserted) {
          throw new PortableImportError(
            422,
            "INVALID_VALIDATION_CHAIN",
            "The validation supersession chain could not be restored.",
          );
        }
      }
      for (const record of document.userSources) {
        if (
          plan.get(`user-source:${record.portableId}`)?.classification !==
          "create"
        )
          continue;
        await transaction.userSourceReference.create({
          data: {
            id: record.portableId,
            actionableId: actionableIds.get(record.actionableId)!.id,
            type: record.type,
            locator: record.locator,
            label: record.label,
            provenance: record.provenance,
            createdAt: new Date(record.createdAt),
            removedAt: record.removedAt ? new Date(record.removedAt) : null,
          },
        });
      }
      for (const record of document.hierarchy) {
        if (
          plan.get(`hierarchy:${record.portableId}`)?.classification !==
          "create"
        )
          continue;
        await transaction.hierarchyRelationship.create({
          data: {
            id: record.portableId,
            parentId: actionableIds.get(record.parentId)!.id,
            childId: actionableIds.get(record.childId)!.id,
            createdAt: new Date(record.createdAt),
            detachedAt: record.detachedAt ? new Date(record.detachedAt) : null,
            provenance: record.provenance,
          },
        });
      }
      for (const record of document.dependencies) {
        if (
          plan.get(`dependency:${record.portableId}`)?.classification !==
          "create"
        )
          continue;
        await transaction.dependencyRelationship.create({
          data: {
            id: record.portableId,
            dependentId: actionableIds.get(record.dependentId)!.id,
            prerequisiteId: actionableIds.get(record.prerequisiteId)!.id,
            createdAt: new Date(record.createdAt),
            waivedAt: record.waivedAt ? new Date(record.waivedAt) : null,
            waiverReason: record.waiverReason,
            removedAt: record.removedAt ? new Date(record.removedAt) : null,
            provenance: record.provenance,
          },
        });
      }
      for (const suggestion of document.relationshipSuggestions) {
        if (!acceptedSuggestions.has(suggestion.portableId)) continue;
        if (suggestion.kind === "hierarchy") {
          await transaction.hierarchyRelationship.create({
            data: {
              id: suggestion.portableId,
              parentId: actionableIds.get(suggestion.fromId)!.id,
              childId: actionableIds.get(suggestion.toId)!.id,
              provenance: `confirmed suggestion: ${suggestion.provenance}`,
            },
          });
        } else {
          await transaction.dependencyRelationship.create({
            data: {
              id: suggestion.portableId,
              dependentId: actionableIds.get(suggestion.fromId)!.id,
              prerequisiteId: actionableIds.get(suggestion.toId)!.id,
              provenance: `confirmed suggestion: ${suggestion.provenance}`,
            },
          });
        }
        for (const actionableId of [suggestion.fromId, suggestion.toId]) {
          await transaction.activityEvent.create({
            data: {
              actionableId: actionableIds.get(actionableId)!.id,
              type:
                suggestion.kind === "hierarchy"
                  ? "hierarchy-attached"
                  : "dependency-added",
              summary: `Confirmed imported ${suggestion.kind} suggestion`,
              metadataJson: json({
                suggestionId: suggestion.portableId,
                provenance: suggestion.provenance,
                reason: suggestion.reason,
              }),
            },
          });
        }
      }
      for (const record of document.activities) {
        if (
          plan.get(`activity:${record.portableId}`)?.classification !== "create"
        )
          continue;
        await transaction.activityEvent.create({
          data: {
            id: record.portableId,
            actionableId: actionableIds.get(record.actionableId)!.id,
            type: record.type,
            summary: record.summary,
            metadataJson: json(record.context),
            occurredAt: new Date(record.occurredAt),
          },
        });
      }

      const importRun = await transaction.importRun.create({
        data: {
          documentDigest: preview.response.contentDigest,
          format: document.format,
          schemaVersion: document.schemaVersion,
          sourceName: document.metadata.sourceName,
          summaryJson: json({
            totals: analysis.response.totals,
            totalsByRecordType: analysis.response.totalsByRecordType,
            acceptedSuggestionIds: [...acceptedSuggestions],
          }),
        },
      });
      const affected = await transaction.actionable.findMany({
        where: { externalKey: { in: analysis.response.affectedActionableIds } },
        select: { externalKey: true, sourceOrdinal: true, title: true },
        orderBy: { externalKey: "asc" },
      });
      return {
        importRunId: importRun.id,
        committedAt: importRun.committedAt.toISOString(),
        summary: analysis.response.totals,
        totalsByRecordType: analysis.response.totalsByRecordType,
        affectedActionables: affected.map((item) => ({
          portableId: item.externalKey,
          id: item.sourceOrdinal,
          title: item.title,
        })),
      } satisfies ImportCommitResponse;
    });
    return result;
  }
}
