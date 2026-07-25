import { z } from "zod";

export const prioritySchema = z.enum([
  "Unset",
  "Critical",
  "High",
  "Medium",
  "Low",
  "Backlog",
]);
export const statusSchema = z.enum([
  "Inbox",
  "Researching",
  "Ready",
  "In progress",
  "Blocked",
  "Done",
  "Dismissed",
]);
export const sourceStatusSuggestionSchema = z.enum(["Ready", "Researching", "Blocked"]);
export const effortSchema = z.enum([
  "Unknown",
  "XS",
  "S",
  "S–M",
  "M",
  "M–L",
  "L",
  "L–XL",
  "XL",
]);
export const evidenceStateSchema = z.enum([
  "Unclassified",
  "Confirmed",
  "Suspected",
  "Proposed",
  "Investigation",
]);

export const sourceFileSchema = z.object({
  path: z.string().min(1),
  lines: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
});

export const userSourceReferenceInputSchema = z.object({
  type: z.enum(["File", "URL", "Command", "Commit", "Codex thread", "Text"]),
  locator: z.string().trim().min(1, "Enter a source locator."),
  label: z.string().trim().max(200).optional(),
});

export const userSourceReferenceSchema = userSourceReferenceInputSchema.extend({
  id: z.string().min(1),
  provenance: z.literal("user-added"),
  createdAt: z.string().datetime(),
});

export const validationTypeSchema = z.enum([
  "Automated test",
  "Manual test",
  "Command",
  "Review",
  "Document",
]);
export const validationOutcomeSchema = z.enum(["Passed", "Failed", "Partial"]);

export const validationRecordSchema = z.object({
  id: z.string().min(1),
  type: validationTypeSchema,
  outcome: validationOutcomeSchema,
  notes: z.string(),
  evidence: z.string(),
  origin: z.string().min(1),
  recordedAt: z.string().datetime(),
  supersedesId: z.string().min(1).nullable(),
  supersededById: z.string().min(1).nullable(),
  qualifiesForCompletion: z.boolean(),
});

export const activityTypeSchema = z.enum([
  "status-transition",
  "manual-blocked",
  "validation-recorded",
  "validation-corrected",
  "completion-validated",
  "completion-overridden",
  "dismissed",
  "reopened",
  "source-added",
  "source-removed",
  "hierarchy-attached",
  "hierarchy-detached",
  "hierarchy-reassigned",
  "dependency-added",
  "dependency-removed",
  "dependency-waived",
  "dependency-restored",
  "parent-auto-reopened",
  "archived",
  "restored",
  "scope-archived",
  "scope-restored",
]);

export const activityEventSchema = z.object({
  id: z.string().min(1),
  type: activityTypeSchema,
  summary: z.string().min(1),
  context: z.record(z.string(), z.string()),
  occurredAt: z.string().datetime(),
});

export const statusProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("neutral-import"),
    note: z.string().min(1),
    suggestedStatus: sourceStatusSuggestionSchema.optional(),
  }),
  z.object({
    kind: z.literal("user-authored"),
    note: z.string().min(1),
  }),
]);

export const scopeSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  repositoryId: z.string().min(1),
  repositoryName: z.string().min(1),
  worktreeId: z.string().min(1),
  worktreeName: z.string().min(1),
});

export const archiveStateSchema = z.object({
  isArchived: z.boolean(),
  directlyArchived: z.boolean(),
  archivedAt: z.string().datetime().nullable(),
  inheritedFrom: z.array(z.enum(["project", "repository", "worktree"])),
});

export const statusHistoryEntrySchema = z.object({
  id: z.string().min(1),
  previousStatus: statusSchema.nullable(),
  newStatus: statusSchema,
  origin: z.string().min(1),
  occurredAt: z.string().datetime(),
});

export const immutableSourceEvidenceSchema = z.object({
  imported: z.boolean(),
  sourceThread: z.string(),
  sourceFiles: z.array(sourceFileSchema),
  rawSource: z.unknown().optional(),
  note: z.string().min(1),
});

export const relatedActionableSchema = z.object({
  id: z.number().int().positive(),
  recordId: z.string().min(1),
  title: z.string().min(1),
  status: statusSchema,
  version: z.number().int().positive(),
  scope: scopeSchema,
  archiveState: archiveStateSchema,
});

export const hierarchyRelationshipSchema = z.object({
  id: z.string().min(1),
  parent: relatedActionableSchema,
  child: relatedActionableSchema,
  createdAt: z.string().datetime(),
});

export const dependencyStateSchema = z.enum([
  "satisfied",
  "unresolved",
  "waived",
  "dismissed-prerequisite",
]);

export const dependencyRelationshipSchema = z.object({
  id: z.string().min(1),
  dependent: relatedActionableSchema,
  prerequisite: relatedActionableSchema,
  state: dependencyStateSchema,
  isSatisfied: z.boolean(),
  waiverReason: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const actionableSummarySchema = z.object({
  id: z.number().int().positive(),
  recordId: z.string().min(1),
  externalKey: z.string().min(1),
  title: z.string().min(1),
  priority: prioritySchema,
  status: statusSchema,
  statusProvenance: statusProvenanceSchema,
  scope: scopeSchema,
  worktree: z.string().min(1),
  effort: effortSchema,
  evidenceState: evidenceStateSchema,
  version: z.number().int().positive(),
  updated: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finding: z.string(),
  tags: z.array(z.string()),
  manualBlocker: z.string().nullable(),
  isDependencyBlocked: z.boolean(),
  isEffectivelyBlocked: z.boolean(),
  unresolvedDependencyCount: z.number().int().nonnegative(),
  dependencyCount: z.number().int().nonnegative(),
  blocksCount: z.number().int().nonnegative(),
  hasQualifyingValidation: z.boolean(),
  wasReopened: z.boolean(),
  archiveState: archiveStateSchema,
  blockedBy: z.array(z.number().int().positive()).optional(),
  blocks: z.array(z.number().int().positive()).optional(),
  parentId: z.number().int().positive().optional(),
  childIds: z.array(z.number().int().positive()).optional(),
  childCompletion: z
    .object({
      terminal: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .optional(),
});

export const actionableDetailSchema = actionableSummarySchema.extend({
  description: z.string(),
  research: z.array(z.string()),
  validation: z.array(z.string()),
  userSources: z.array(userSourceReferenceSchema),
  immutableSourceEvidence: immutableSourceEvidenceSchema,
  files: z.array(sourceFileSchema),
  sourceThread: z.string(),
  permittedTransitions: z.array(statusSchema),
  statusHistory: z.array(statusHistoryEntrySchema),
  validationRecords: z.array(validationRecordSchema),
  activity: z.array(activityEventSchema),
  completionEligibility: z.object({
    qualifyingValidationRecordId: z.string().min(1).nullable(),
    policy: z.string().min(1),
  }),
  relationships: z.object({
    parent: hierarchyRelationshipSchema.nullable(),
    subtasks: z.array(hierarchyRelationshipSchema),
    blockedBy: z.array(dependencyRelationshipSchema),
    blocks: z.array(dependencyRelationshipSchema),
  }),
});

export const actionablesListResponseSchema = z.object({
  project: z.object({
    name: z.string().min(1),
  }),
  repository: z.object({
    name: z.string().min(1),
  }),
  worktree: z.object({
    name: z.string().min(1),
  }),
  counts: z.object({
    total: z.number().int().nonnegative(),
    topLevel: z.number().int().nonnegative(),
  }),
  result: z.object({
    matched: z.number().int().nonnegative(),
    scopeTotal: z.number().int().nonnegative(),
    topLevel: z.number().int().nonnegative(),
    nested: z.number().int().nonnegative(),
    normalizedQuery: z.record(z.string(), z.string()),
  }),
  items: z.array(actionableSummarySchema),
});

export const actionableDetailResponseSchema = z.object({
  item: actionableDetailSchema,
});

export const scopeOptionsResponseSchema = z.object({
  projects: z.array(
    z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          version: z.number().int().positive(),
          archivedAt: z.string().datetime().nullable(),
          archiveState: archiveStateSchema,
          repositories: z.array(
            z.object({
              id: z.string().min(1),
              name: z.string().min(1),
              version: z.number().int().positive(),
              archivedAt: z.string().datetime().nullable(),
              archiveState: archiveStateSchema,
              worktrees: z.array(
                z.object({
                  id: z.string().min(1),
                  name: z.string().min(1),
                  version: z.number().int().positive(),
                  archivedAt: z.string().datetime().nullable(),
                  archiveState: archiveStateSchema,
                }),
              ),
        }),
      ),
    }),
  ),
});

export const actionableSortSchema = z.enum([
  "priority",
  "updated-desc",
  "updated-asc",
  "created-desc",
  "title",
  "status",
  "effort",
]);
export const archivedFilterSchema = z.enum(["active", "archived", "all"]);
export const parentFilterSchema = z.enum(["all", "top-level", "subtasks"]);
export const booleanFilterSchema = z.enum(["all", "yes", "no"]);

export const actionableQuerySchema = z.object({
  project: z.string().default(""),
  repository: z.string().default(""),
  worktree: z.string().default(""),
  status: statusSchema.optional(),
  manualBlocked: booleanFilterSchema.default("all"),
  dependencyBlocked: booleanFilterSchema.default("all"),
  priority: prioritySchema.optional(),
  effort: effortSchema.optional(),
  evidence: evidenceStateSchema.optional(),
  tag: z.string().default(""),
  archived: archivedFilterSchema.default("active"),
  parent: parentFilterSchema.default("all"),
  validation: booleanFilterSchema.default("all"),
  reopened: booleanFilterSchema.default("all"),
  q: z.string().trim().max(500).default(""),
  sort: actionableSortSchema.default("priority"),
});

export const dashboardQueueKeySchema = z.enum([
  "inbox",
  "researching",
  "ready",
  "in-progress",
  "manual-blocked",
  "dependency-blocked",
  "awaiting-validation",
  "recently-updated",
  "recently-completed",
  "reopened",
]);

export const dashboardQueueSchema = z.object({
  key: dashboardQueueKeySchema,
  label: z.string().min(1),
  description: z.string().min(1),
  count: z.number().int().nonnegative(),
  query: z.record(z.string(), z.string()),
  items: z.array(actionableSummarySchema),
});

export const dashboardResponseSchema = z.object({
  counts: z.object({
    total: z.number().int().nonnegative(),
    topLevel: z.number().int().nonnegative(),
    nested: z.number().int().nonnegative(),
  }),
  queues: z.array(dashboardQueueSchema),
});

export const archiveMutationRequestSchema = z.object({
  version: z.number().int().positive(),
}).strict();

export const archiveTargetKindSchema = z.enum([
  "actionable",
  "project",
  "repository",
  "worktree",
]);

export const archiveImpactResponseSchema = z.object({
  target: z.object({
    kind: archiveTargetKindSchema,
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.number().int().positive(),
    directlyArchived: z.boolean(),
  }),
  counts: z.object({
    activeSubtasks: z.number().int().nonnegative(),
    descendants: z.number().int().nonnegative(),
    blocks: z.number().int().nonnegative(),
    unresolvedPrerequisites: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string().min(1)),
});

const titleField = z.string().trim().min(1, "Enter a title.").max(240);
const markdownField = z.string().trim().max(100_000);
const notesSchema = z.array(z.string().trim().min(1)).max(200);
const tagsSchema = z.array(z.string().trim().min(1).max(60)).max(30);

export const createActionableRequestSchema = z
  .object({
    title: titleField,
    priority: prioritySchema.default("Unset"),
    effort: effortSchema.default("Unknown"),
    evidenceState: evidenceStateSchema.default("Unclassified"),
    projectId: z.string().min(1, "Choose a project."),
    repositoryId: z.string().min(1, "Choose a repository."),
    worktreeId: z.string().min(1, "Choose a worktree."),
    finding: markdownField,
    description: markdownField,
    research: notesSchema.default([]),
    validation: notesSchema.default([]),
    tags: tagsSchema.default([]),
    userSources: z.array(userSourceReferenceInputSchema).max(50).default([]),
  })
  .strict();

export const updateActionableRequestSchema = createActionableRequestSchema
  .extend({
    version: z.number().int().positive(),
    status: statusSchema,
  })
  .strict();

export const statusTransitionRequestSchema = z
  .object({
    version: z.number().int().positive(),
    status: statusSchema,
    reason: z.string().trim().max(10_000).optional(),
    completionOverrideReason: z.string().trim().max(10_000).optional(),
    origin: z.literal("user").default("user"),
  })
  .strict();

export const createValidationRecordRequestSchema = z
  .object({
    version: z.number().int().positive(),
    type: validationTypeSchema,
    outcome: validationOutcomeSchema,
    notes: z.string().trim().max(100_000).default(""),
    evidence: z.string().trim().max(100_000).default(""),
    origin: z.literal("user").default("user"),
    supersedesId: z.string().trim().min(1).optional(),
  })
  .strict();

export const createSubtaskRequestSchema = z
  .object({
    version: z.number().int().positive(),
    title: titleField,
  })
  .strict();

export const setParentRequestSchema = z
  .object({
    version: z.number().int().positive(),
    parentId: z.number().int().positive(),
    parentVersion: z.number().int().positive(),
    currentParentVersion: z.number().int().positive().optional(),
  })
  .strict();

export const detachParentRequestSchema = z
  .object({
    version: z.number().int().positive(),
    parentVersion: z.number().int().positive(),
  })
  .strict();

export const createDependencyRequestSchema = z
  .object({
    version: z.number().int().positive(),
    prerequisiteId: z.number().int().positive(),
    prerequisiteVersion: z.number().int().positive(),
  })
  .strict();

export const dependencyActionRequestSchema = z
  .object({
    version: z.number().int().positive(),
    prerequisiteVersion: z.number().int().positive(),
    reason: z.string().trim().max(10_000).optional(),
  })
  .strict();

export const fieldErrorsSchema = z.record(z.string(), z.array(z.string()));
export const problemDetailsSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int(),
  code: z.string().min(1),
  requestId: z.string().min(1),
  detail: z.string().optional(),
  errors: fieldErrorsSchema.optional(),
  current: actionableDetailSchema.optional(),
});

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  database: z.literal("ok"),
  requestId: z.string().min(1),
});

const seedScopeSchema = z.object({
  externalKey: z.string().min(1),
  name: z.string().min(1),
  localPath: z.string().optional(),
});

const seedPrioritySchema = z.enum(["Critical", "High", "Medium", "Low"]);
const seedStatusProvenanceSchema = z.object({
  kind: z.literal("neutral-import"),
  note: z.string().min(1),
  suggestedStatus: sourceStatusSuggestionSchema.optional(),
});

export const seedActionableSchema = z.object({
  ordinal: z.number().int().positive(),
  externalKey: z.string().min(1),
  title: z.string().min(1),
  priority: seedPrioritySchema,
  status: z.literal("Inbox"),
  statusProvenance: seedStatusProvenanceSchema,
  effort: effortSchema.exclude(["Unknown", "XS", "L–XL", "XL"]),
  updated: z.string().min(1),
  finding: z.string().min(1),
  description: z.string().min(1),
  research: z.array(z.string()),
  validation: z.array(z.string()),
  files: z.array(sourceFileSchema),
  tags: z.array(z.string()),
  blockedBy: z.array(z.number().int().positive()).optional(),
  blocks: z.array(z.number().int().positive()).optional(),
  parentId: z.number().int().positive().optional(),
  childIds: z.array(z.number().int().positive()).optional(),
});

export const seedDocumentSchema = z.object({
  version: z.literal(1),
  source: z.object({
    provider: z.literal("CODEX"),
    containerId: z.string().min(1),
    threadUrl: z.string().min(1),
  }),
  project: seedScopeSchema,
  repository: seedScopeSchema,
  worktree: seedScopeSchema,
  statusPolicy: z.object({
    initialStatus: z.literal("Inbox"),
    note: z.string().min(1),
  }),
  items: z.array(seedActionableSchema).length(32),
});

export const portableFormat = "actionables-portable" as const;
export const portableSchemaVersion = 1 as const;

const portableIdSchema = z.string().trim().min(1).max(240);
const portableTimestampSchema = z.string().datetime();
const portableArchiveSchema = z
  .object({
    directArchivedAt: portableTimestampSchema.nullable(),
    inheritedFrom: z
      .array(z.enum(["project", "repository", "worktree"]))
      .max(3),
  })
  .strict();

const portableProjectSchema = z
  .object({
    portableId: portableIdSchema,
    name: z.string().trim().min(1).max(240),
    archive: portableArchiveSchema,
    createdAt: portableTimestampSchema.optional(),
    updatedAt: portableTimestampSchema.optional(),
  })
  .strict();

const portableRepositorySchema = z
  .object({
    portableId: portableIdSchema,
    projectId: portableIdSchema,
    name: z.string().trim().min(1).max(240),
    localPath: z.string().max(4_096).nullable(),
    archive: portableArchiveSchema,
    createdAt: portableTimestampSchema.optional(),
    updatedAt: portableTimestampSchema.optional(),
  })
  .strict();

const portableWorktreeSchema = z
  .object({
    portableId: portableIdSchema,
    projectId: portableIdSchema,
    repositoryId: portableIdSchema,
    name: z.string().trim().min(1).max(240),
    localPath: z.string().max(4_096).nullable(),
    archive: portableArchiveSchema,
    createdAt: portableTimestampSchema.optional(),
    updatedAt: portableTimestampSchema.optional(),
  })
  .strict();

export const portableFieldOwnershipSchema = z.record(
  z.string().min(1),
  z.enum(["imported", "user-authored"]),
);

const portableActionableSchema = z
  .object({
    portableId: portableIdSchema,
    projectId: portableIdSchema,
    repositoryId: portableIdSchema,
    worktreeId: portableIdSchema,
    title: titleField,
    priority: prioritySchema,
    status: statusSchema,
    statusProvenance: statusProvenanceSchema,
    effort: effortSchema,
    evidenceState: evidenceStateSchema,
    finding: z.string().max(100_000),
    description: z.string().max(100_000),
    research: notesSchema,
    validation: notesSchema,
    files: z.array(sourceFileSchema).max(500),
    tags: tagsSchema,
    manualBlocker: z.string().max(100_000).nullable(),
    dismissalReason: z.string().max(100_000).nullable(),
    completionOverride: z.string().max(100_000).nullable(),
    archive: portableArchiveSchema,
    importedEvidence: z
      .object({
        provider: z.string().max(120),
        containerId: z.string().max(500),
        threadUrl: z.string().max(4_096),
        contentHash: z.string().max(128),
        rawFragment: z.json(),
      })
      .strict(),
    provenance: z
      .object({
        origin: z.enum(["imported", "user-authored"]),
        fieldOwnership: portableFieldOwnershipSchema,
      })
      .strict(),
    createdAt: portableTimestampSchema.optional(),
    updatedAt: portableTimestampSchema.optional(),
  })
  .strict();

const portableStatusHistorySchema = z
  .object({
    portableId: portableIdSchema,
    actionableId: portableIdSchema,
    previousStatus: statusSchema.nullable(),
    newStatus: statusSchema,
    origin: z.string().min(1).max(200),
    occurredAt: portableTimestampSchema,
  })
  .strict();

const portableValidationRecordSchema = z
  .object({
    portableId: portableIdSchema,
    actionableId: portableIdSchema,
    type: validationTypeSchema,
    outcome: validationOutcomeSchema,
    notes: z.string().max(100_000),
    evidence: z.string().max(100_000),
    origin: z.string().min(1).max(200),
    recordedAt: portableTimestampSchema,
    supersedesId: portableIdSchema.nullable(),
  })
  .strict();

const portableUserSourceSchema = z
  .object({
    portableId: portableIdSchema,
    actionableId: portableIdSchema,
    type: userSourceReferenceInputSchema.shape.type,
    locator: z.string().trim().min(1).max(4_096),
    label: z.string().trim().max(200).nullable(),
    provenance: z.literal("user-added"),
    createdAt: portableTimestampSchema,
    removedAt: portableTimestampSchema.nullable(),
  })
  .strict();

const portableActivitySchema = z
  .object({
    portableId: portableIdSchema,
    actionableId: portableIdSchema,
    type: activityTypeSchema,
    summary: z.string().min(1).max(1_000),
    context: z.record(z.string(), z.string()),
    occurredAt: portableTimestampSchema,
  })
  .strict();

const portableHierarchySchema = z
  .object({
    portableId: portableIdSchema,
    parentId: portableIdSchema,
    childId: portableIdSchema,
    createdAt: portableTimestampSchema,
    detachedAt: portableTimestampSchema.nullable(),
    provenance: z.string().min(1).max(200),
  })
  .strict();

const portableDependencySchema = z
  .object({
    portableId: portableIdSchema,
    dependentId: portableIdSchema,
    prerequisiteId: portableIdSchema,
    createdAt: portableTimestampSchema,
    waivedAt: portableTimestampSchema.nullable(),
    waiverReason: z.string().max(100_000).nullable(),
    removedAt: portableTimestampSchema.nullable(),
    provenance: z.string().min(1).max(200),
  })
  .strict();

export const relationshipSuggestionSchema = z
  .object({
    portableId: portableIdSchema,
    kind: z.enum(["hierarchy", "dependency"]),
    fromId: portableIdSchema,
    toId: portableIdSchema,
    reason: z.string().min(1).max(10_000),
    provenance: z.string().min(1).max(500),
  })
  .strict();

export const portableDocumentSchema = z
  .object({
    format: z.literal(portableFormat),
    schemaVersion: z.literal(portableSchemaVersion),
    exportedAt: portableTimestampSchema,
    application: z
      .object({
        name: z.literal("Actionables"),
        version: z.string().min(1).max(100),
        schema: z.string().min(1).max(100),
      })
      .strict(),
    metadata: z
      .object({
        sourceName: z.string().max(500).nullable(),
        sourceKind: z.enum(["backup", "reviewed-seed", "user-json"]),
      })
      .strict(),
    projects: z.array(portableProjectSchema).max(10_000),
    repositories: z.array(portableRepositorySchema).max(10_000),
    worktrees: z.array(portableWorktreeSchema).max(10_000),
    actionables: z.array(portableActionableSchema).max(100_000),
    statusHistory: z.array(portableStatusHistorySchema).max(500_000),
    validationRecords: z.array(portableValidationRecordSchema).max(500_000),
    userSources: z.array(portableUserSourceSchema).max(500_000),
    activities: z.array(portableActivitySchema).max(1_000_000),
    hierarchy: z.array(portableHierarchySchema).max(200_000),
    dependencies: z.array(portableDependencySchema).max(500_000),
    relationshipSuggestions: z.array(relationshipSuggestionSchema).max(500_000),
  })
  .strict();

export const importClassificationSchema = z.enum([
  "create",
  "safe-update",
  "no-op",
  "conflict",
  "invalid",
  "missing-reference",
  "integrity-failure",
  "suggestion",
]);

export const importPreviewChangeSchema = z
  .object({
    field: z.string().min(1),
    current: z.unknown().optional(),
    incoming: z.unknown().optional(),
    reason: z.string().min(1),
  })
  .strict();

export const importPreviewItemSchema = z
  .object({
    id: z.string().min(1),
    recordType: z.string().min(1),
    portableId: z.string().min(1),
    display: z.string().min(1),
    classification: importClassificationSchema,
    changes: z.array(importPreviewChangeSchema),
    errors: z.array(z.string()),
  })
  .strict();

const importCountSchema = z
  .object({
    creates: z.number().int().nonnegative(),
    safeUpdates: z.number().int().nonnegative(),
    noOps: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    missingReferences: z.number().int().nonnegative(),
    integrityFailures: z.number().int().nonnegative(),
    suggestions: z.number().int().nonnegative(),
  })
  .strict();

export const importPreviewResponseSchema = z
  .object({
    previewToken: z.string().min(1),
    contentDigest: z.string().length(64),
    expiresAt: portableTimestampSchema,
    schemaVersion: z.literal(portableSchemaVersion),
    compatibility: z.string().min(1),
    canCommit: z.boolean(),
    items: z.array(importPreviewItemSchema),
    totals: importCountSchema,
    totalsByRecordType: z.record(z.string(), importCountSchema),
    archiveEffects: z.array(z.string()),
    lifecycleEffects: z.array(z.string()),
    affectedActionableIds: z.array(portableIdSchema),
  })
  .strict();

export const prepareImportCommitRequestSchema = z
  .object({
    contentDigest: z.string().length(64),
    conflictResolutions: z.record(z.string(), z.literal("skip")),
    acceptedSuggestionIds: z.array(z.string().min(1)),
  })
  .strict();

export const prepareImportCommitResponseSchema = z
  .object({
    commitToken: z.string().min(1),
    selectionsDigest: z.string().length(64),
    expiresAt: portableTimestampSchema,
  })
  .strict();

export const commitImportRequestSchema = z
  .object({
    contentDigest: z.string().length(64),
    commitToken: z.string().min(1),
    selectionsDigest: z.string().length(64),
  })
  .strict();

export const importCommitResponseSchema = z
  .object({
    importRunId: z.string().min(1),
    committedAt: portableTimestampSchema,
    summary: importCountSchema,
    totalsByRecordType: z.record(z.string(), importCountSchema),
    affectedActionables: z.array(
      z
        .object({
          portableId: portableIdSchema,
          id: z.number().int().positive(),
          title: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type Priority = z.infer<typeof prioritySchema>;
export type Status = z.infer<typeof statusSchema>;
export type Effort = z.infer<typeof effortSchema>;
export type EvidenceState = z.infer<typeof evidenceStateSchema>;
export type ArchiveState = z.infer<typeof archiveStateSchema>;
export type SourceFile = z.infer<typeof sourceFileSchema>;
export type UserSourceReferenceInput = z.infer<typeof userSourceReferenceInputSchema>;
export type UserSourceReference = z.infer<typeof userSourceReferenceSchema>;
export type ValidationType = z.infer<typeof validationTypeSchema>;
export type ValidationOutcome = z.infer<typeof validationOutcomeSchema>;
export type ValidationRecord = z.infer<typeof validationRecordSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type RelatedActionable = z.infer<typeof relatedActionableSchema>;
export type HierarchyRelationship = z.infer<typeof hierarchyRelationshipSchema>;
export type DependencyState = z.infer<typeof dependencyStateSchema>;
export type DependencyRelationship = z.infer<typeof dependencyRelationshipSchema>;
export type StatusProvenance = z.infer<typeof statusProvenanceSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type ActionableSummary = z.infer<typeof actionableSummarySchema>;
export type ActionableDetail = z.infer<typeof actionableDetailSchema>;
export type ActionablesListResponse = z.infer<typeof actionablesListResponseSchema>;
export type ScopeOptionsResponse = z.infer<typeof scopeOptionsResponseSchema>;
export type ActionableQuery = z.infer<typeof actionableQuerySchema>;
export type ActionableSort = z.infer<typeof actionableSortSchema>;
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
export type ArchiveMutationRequest = z.infer<typeof archiveMutationRequestSchema>;
export type ArchiveTargetKind = z.infer<typeof archiveTargetKindSchema>;
export type ArchiveImpactResponse = z.infer<typeof archiveImpactResponseSchema>;
export type CreateActionableRequest = z.infer<typeof createActionableRequestSchema>;
export type UpdateActionableRequest = z.infer<typeof updateActionableRequestSchema>;
export type StatusTransitionRequest = z.infer<typeof statusTransitionRequestSchema>;
export type CreateValidationRecordRequest = z.infer<
  typeof createValidationRecordRequestSchema
>;
export type CreateSubtaskRequest = z.infer<typeof createSubtaskRequestSchema>;
export type SetParentRequest = z.infer<typeof setParentRequestSchema>;
export type DetachParentRequest = z.infer<typeof detachParentRequestSchema>;
export type CreateDependencyRequest = z.infer<typeof createDependencyRequestSchema>;
export type DependencyActionRequest = z.infer<typeof dependencyActionRequestSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type ActionableDetailResponse = z.infer<typeof actionableDetailResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type SeedDocument = z.infer<typeof seedDocumentSchema>;
export type PortableDocument = z.infer<typeof portableDocumentSchema>;
export type PortableActionable = PortableDocument["actionables"][number];
export type RelationshipSuggestion = z.infer<typeof relationshipSuggestionSchema>;
export type ImportClassification = z.infer<typeof importClassificationSchema>;
export type ImportPreviewItem = z.infer<typeof importPreviewItemSchema>;
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;
export type PrepareImportCommitRequest = z.infer<typeof prepareImportCommitRequestSchema>;
export type PrepareImportCommitResponse = z.infer<typeof prepareImportCommitResponseSchema>;
export type CommitImportRequest = z.infer<typeof commitImportRequestSchema>;
export type ImportCommitResponse = z.infer<typeof importCommitResponseSchema>;
