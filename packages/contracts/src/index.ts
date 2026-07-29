import { z } from "zod";

export const defaultApiPort = 4174;
export const loopbackApiHost = "127.0.0.1";

export type ApiRuntimeConfig = {
  apiHost: typeof loopbackApiHost;
  apiPort: number;
  apiOrigin: string;
  mcpEndpoint: string;
};

export function resolveApiRuntimeConfig(
  configuredPort: string | undefined,
): ApiRuntimeConfig {
  const normalizedPort = configuredPort?.trim();
  if (
    configuredPort !== undefined &&
    (!normalizedPort || !/^\d+$/.test(normalizedPort))
  ) {
    throw new Error("API_PORT must be a whole number from 1 through 65535.");
  }

  const apiPort =
    normalizedPort === undefined ? defaultApiPort : Number(normalizedPort);
  if (!Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65_535) {
    throw new Error("API_PORT must be a whole number from 1 through 65535.");
  }

  const apiOrigin = `http://${loopbackApiHost}:${apiPort}`;
  return {
    apiHost: loopbackApiHost,
    apiPort,
    apiOrigin,
    mcpEndpoint: `${apiOrigin}/mcp`,
  };
}

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
export const sourceStatusSuggestionSchema = z.enum([
  "Ready",
  "Researching",
  "Blocked",
]);
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
  path: z.string().min(1).describe("Repository-relative file path."),
  lines: z
    .string()
    .min(1)
    .optional()
    .describe("Optional relevant line or line range."),
  symbol: z
    .string()
    .min(1)
    .optional()
    .describe("Optional relevant symbol name."),
});

export const userSourceReferenceInputSchema = z.object({
  type: z
    .enum(["File", "URL", "Command", "Commit", "Codex thread", "Text"])
    .describe("Kind of source reference."),
  locator: z
    .string()
    .trim()
    .min(1, "Enter a source locator.")
    .describe("Path, URL, command, commit, thread, or text locator."),
  label: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Optional human-readable source label."),
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
  "task-breakdown-created",
  "dependency-added",
  "dependency-removed",
  "dependency-waived",
  "dependency-restored",
  "parent-auto-reopened",
  "archived",
  "restored",
  "scope-archived",
  "scope-restored",
  "agent-claimed",
  "agent-released",
  "agent-claim-expired",
  "agent-updated",
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
  agentClaim: z
    .object({
      agentId: z.string().min(1).max(120),
      claimedAt: z.string().datetime(),
      renewedAt: z.string().datetime(),
      leaseExpiresAt: z.string().datetime(),
      state: z.enum(["active", "expired"]),
      isReleasable: z.boolean(),
    })
    .strict()
    .nullable(),
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

export const createRepositoryRequestSchema = z
  .object({
    projectId: z.string().min(1, "Choose a project."),
    name: z.string().trim().min(1, "Enter a repository name.").max(240),
    localPath: z
      .string()
      .trim()
      .min(1, "Enter the local repository path.")
      .max(4_096)
      .refine(
        (value) => /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value),
        "Enter an absolute Windows path.",
      ),
  })
  .strict();

export const createRepositoryResponseSchema = z.object({
  projectId: z.string().min(1),
  repositoryId: z.string().min(1),
  worktreeId: z.string().min(1),
  scopes: scopeOptionsResponseSchema,
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
export const actionableStatusFilterSchema = statusSchema.or(
  z.enum(["active", "all"]),
);

export const actionableQuerySchema = z.object({
  project: z.string().default(""),
  repository: z.string().default(""),
  worktree: z.string().default(""),
  status: actionableStatusFilterSchema.default("active"),
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

export const dashboardAlertKeySchema = z.enum([
  "expiring-claims",
  "blocked-work",
  "missing-validation",
  "abandoned-sessions",
]);

export const dashboardAlertItemSchema = z.object({
  actionable: actionableSummarySchema,
  detail: z.string().min(1),
  dueAt: z.string().datetime().nullable(),
});

export const dashboardAlertSchema = z.object({
  key: dashboardAlertKeySchema,
  label: z.string().min(1),
  description: z.string().min(1),
  tone: z.enum(["warning", "critical"]),
  count: z.number().int().nonnegative(),
  items: z.array(dashboardAlertItemSchema),
});

export const dashboardResponseSchema = z.object({
  counts: z.object({
    total: z.number().int().nonnegative(),
    topLevel: z.number().int().nonnegative(),
    nested: z.number().int().nonnegative(),
  }),
  alerts: z.array(dashboardAlertSchema),
  queues: z.array(dashboardQueueSchema),
});

export const agentIdSchema = z
  .string()
  .trim()
  .min(1, "Enter an agent ID.")
  .max(120)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/,
    "Use letters, numbers, and . _ : @ / - only.",
  )
  .describe("Stable ID for this agent task session.");
export const agentTaskLeaseMinutesSchema = z
  .number()
  .int()
  .min(5)
  .max(120)
  .describe("Claim lease duration in minutes, from 5 through 120.");
export const agentClaimExpiryWarningMinutesSchema = z
  .number()
  .int()
  .min(1)
  .max(119)
  .describe("Expiring-claim warning window in minutes, from 1 through 119.");
export const agentTaskListViewSchema = z
  .enum(["available", "mine"])
  .describe("Use mine for owned claims or available within one work item.");

export const agentTaskSummarySchema = z
  .object({
    id: z.number().int().positive(),
    recordId: z.string().min(1),
    workItemId: z.number().int().positive(),
    parentId: z.number().int().positive().nullable(),
    childIds: z.array(z.number().int().positive()).max(100),
    title: z.string().min(1).max(240),
    findingExcerpt: z.string().max(300),
    tags: z.array(z.string().min(1).max(60)).max(10),
    priority: prioritySchema,
    status: statusSchema,
    effort: effortSchema,
    evidenceState: evidenceStateSchema,
    isEffectivelyBlocked: z.boolean(),
    unresolvedDependencyCount: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    scope: scopeSchema,
    updatedAt: z.string().datetime(),
    claim: z
      .object({
        agentId: agentIdSchema,
        claimedAt: z.string().datetime(),
        renewedAt: z.string().datetime(),
        leaseExpiresAt: z.string().datetime(),
      })
      .nullable(),
  })
  .strict();

export const listAgentTasksRequestSchema = z
  .object({
    agentId: agentIdSchema,
    view: agentTaskListViewSchema.default("mine"),
    workItemId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Top-level Actionable ID for the current feature or bug; required for available.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Maximum tasks to return, from 1 through 100."),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.view === "available" && input.workItemId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["workItemId"],
        message:
          "Available tasks require the top-level feature or bug work-item ID.",
      });
    }
  });

export const listAgentTasksResponseSchema = z
  .object({
    items: z.array(agentTaskSummarySchema).max(100),
  })
  .strict();

export const claimAgentTaskRequestSchema = z
  .object({
    agentId: agentIdSchema,
    workItemId: z
      .number()
      .int()
      .positive()
      .describe("Top-level Actionable ID for the current feature or bug."),
    version: z
      .number()
      .int()
      .positive()
      .describe("Exact task version returned by list_tasks."),
    leaseMinutes: agentTaskLeaseMinutesSchema
      .optional()
      .describe(
        "Optional claim lease duration; omit to use the saved default.",
      ),
  })
  .strict();

export const agentTaskClaimCredentialSchema = z
  .object({
    agentId: agentIdSchema,
    claimToken: z.string().min(32).max(256),
    claimedAt: z.string().datetime(),
    renewedAt: z.string().datetime(),
    leaseExpiresAt: z.string().datetime(),
  })
  .strict();

export const claimAgentTaskResponseSchema = z
  .object({
    task: agentTaskSummarySchema,
    claim: agentTaskClaimCredentialSchema,
  })
  .strict();

export const recoverAgentTaskClaimRequestSchema = z
  .object({
    version: z
      .number()
      .int()
      .positive()
      .describe("Current task version returned by list_tasks(view: mine)."),
    leaseMinutes: agentTaskLeaseMinutesSchema
      .optional()
      .describe(
        "Optional recovered-claim lease duration; omit to use the saved default.",
      ),
  })
  .strict();

export const recoverAgentTaskClaimResponseSchema = claimAgentTaskResponseSchema;

export const renewAgentTaskClaimRequestSchema = z
  .object({
    claimToken: z
      .string()
      .min(32)
      .max(256)
      .describe("Secret claim token returned by claim_task."),
    leaseMinutes: agentTaskLeaseMinutesSchema
      .optional()
      .describe(
        "Optional renewal lease duration; omit to use the saved default.",
      ),
  })
  .strict();

export const renewAgentTaskClaimResponseSchema = z
  .object({
    task: agentTaskSummarySchema,
  })
  .strict();

export const releaseAgentTaskClaimRequestSchema = z
  .object({
    claimToken: z
      .string()
      .min(32)
      .max(256)
      .describe("Secret claim token returned by claim_task."),
  })
  .strict();

export const releaseAgentTaskClaimResponseSchema = z
  .object({
    task: agentTaskSummarySchema,
  })
  .strict();

export const forceReleaseAgentClaimRequestSchema = z
  .object({
    version: z.number().int().positive(),
    agentId: agentIdSchema,
    claimedAt: z.string().datetime(),
  })
  .strict();

export const archiveMutationRequestSchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

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

export const groomActionableNotesRequestSchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

const helperAgentPromptSchema = z.string().trim().min(1).max(20_000);

export const defaultLocalCodexTimeoutSeconds = 120;
export const minimumLocalCodexTimeoutSeconds = 30;
export const maximumLocalCodexTimeoutSeconds = 900;
export const localCodexTimeoutSecondsSchema = z
  .number()
  .int()
  .min(minimumLocalCodexTimeoutSeconds)
  .max(maximumLocalCodexTimeoutSeconds)
  .describe(
    `Local Codex request timeout in seconds, from ${minimumLocalCodexTimeoutSeconds} through ${maximumLocalCodexTimeoutSeconds}.`,
  );

export const noteGroomerModels = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
export const noteGroomerModelSchema = z.enum(noteGroomerModels);

export const assistantReasoningEfforts = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const assistantReasoningEffortSchema = z.enum(assistantReasoningEfforts);

const helperAgentSettingsBaseSchema = z
  .object({
    agentClaimLeaseMinutes: agentTaskLeaseMinutesSchema,
    agentClaimExpiryWarningMinutes: agentClaimExpiryWarningMinutesSchema,
    localCodexTimeoutSeconds: localCodexTimeoutSecondsSchema.nullable(),
    localCodexEffectiveTimeoutSeconds: localCodexTimeoutSecondsSchema,
    noteGroomerEnabled: z.boolean(),
    noteGroomerModel: noteGroomerModelSchema.nullable(),
    noteGroomerReasoningEffort: assistantReasoningEffortSchema.nullable(),
    noteGroomerEffectiveModel: z.string().trim().min(1).max(200),
    noteGroomerPrompt: helperAgentPromptSchema,
    relationshipAuditorEnabled: z.boolean(),
    relationshipAuditorModel: noteGroomerModelSchema.nullable(),
    relationshipAuditorReasoningEffort:
      assistantReasoningEffortSchema.nullable(),
    relationshipAuditorEffectiveModel: z.string().trim().min(1).max(200),
    relationshipAuditorPrompt: helperAgentPromptSchema,
    version: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

function validateAgentCoordinationSettings(
  input: {
    agentClaimLeaseMinutes: number;
    agentClaimExpiryWarningMinutes: number;
  },
  context: z.RefinementCtx,
) {
  if (input.agentClaimExpiryWarningMinutes >= input.agentClaimLeaseMinutes) {
    context.addIssue({
      code: "custom",
      path: ["agentClaimExpiryWarningMinutes"],
      message: "The expiry warning must be shorter than the claim lease.",
    });
  }
}

export const helperAgentSettingsSchema =
  helperAgentSettingsBaseSchema.superRefine(validateAgentCoordinationSettings);

export const updateHelperAgentSettingsRequestSchema =
  helperAgentSettingsBaseSchema
    .omit({
      localCodexEffectiveTimeoutSeconds: true,
      noteGroomerEffectiveModel: true,
      relationshipAuditorEffectiveModel: true,
      updatedAt: true,
    })
    .strict()
    .superRefine(validateAgentCoordinationSettings);

export const agentIntegrationComponentIdSchema = z.enum([
  "mcpServer",
  "agentInstructions",
  "skill",
]);

export const agentIntegrationComponentSchema = z
  .object({
    id: agentIntegrationComponentIdSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    targetPath: z.string().min(1),
    state: z.enum(["missing", "outdated", "installed", "modified"]),
    installed: z.boolean(),
  })
  .strict();

export const agentIntegrationSettingsSchema = z
  .object({
    mcp: z
      .object({
        apiOrigin: z.string().url(),
        endpoint: z.string().url(),
        enabled: z.boolean(),
        bearerTokenEnvironmentVariable: z.literal("ACTIONABLES_MCP_TOKEN"),
      })
      .strict(),
    mcpServer: agentIntegrationComponentSchema,
    agentInstructions: agentIntegrationComponentSchema,
    skill: agentIntegrationComponentSchema,
  })
  .strict();

export const installAgentIntegrationRequestSchema = z
  .object({
    mcpServer: z.boolean(),
    agentInstructions: z.boolean(),
    skill: z.boolean(),
  })
  .strict()
  .refine(
    (input) => input.mcpServer || input.agentInstructions || input.skill,
    {
      message: "Select at least one component to install.",
      path: ["components"],
    },
  );

export const agentIntegrationInstallResultSchema = z
  .object({
    component: agentIntegrationComponentIdSchema,
    outcome: z.enum(["installed", "updated", "already-installed"]),
    message: z.string().min(1),
  })
  .strict();

export const agentIntegrationInstallResponseSchema = z
  .object({
    settings: agentIntegrationSettingsSchema,
    results: z.array(agentIntegrationInstallResultSchema).min(1).max(3),
  })
  .strict();

export const groomActionableNotesProposalSchema = z
  .object({
    description: markdownField.describe(
      "Reorganized description preserving the original meaning.",
    ),
    research: notesSchema.describe(
      "Reorganized research notes containing no invented evidence.",
    ),
    validation: notesSchema.describe(
      "Reorganized planned checks containing no claimed test results.",
    ),
    changes: z
      .array(z.string().trim().min(1).max(500))
      .max(20)
      .describe("Concise summary of formatting and organization changes."),
  })
  .strict();

export const groomActionableNotesResponseSchema = z
  .object({
    basedOnVersion: z.number().int().positive(),
    model: z.string().trim().min(1).max(200),
    proposal: groomActionableNotesProposalSchema,
  })
  .strict();

export const auditActionableRelationshipsRequestSchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

export const relationshipAuditRecommendationSchema = z
  .object({
    kind: z.enum(["hierarchy", "dependency"]),
    action: z.enum(["add", "remove", "review"]),
    fromId: z
      .number()
      .int()
      .positive()
      .describe(
        "Parent ID for hierarchy; dependent ID for dependency recommendations.",
      ),
    toId: z
      .number()
      .int()
      .positive()
      .describe(
        "Child ID for hierarchy; prerequisite ID for dependency recommendations.",
      ),
    confidence: z.enum(["low", "medium", "high"]),
    reason: z.string().trim().min(1).max(2_000),
    evidence: z.array(z.string().trim().min(1).max(1_000)).max(10),
  })
  .strict();

export const relationshipAuditProposalSchema = z
  .object({
    recommendations: z.array(relationshipAuditRecommendationSchema).max(50),
  })
  .strict();

export const relationshipAuditResponseSchema = z
  .object({
    workItemId: z.number().int().positive(),
    basedOnVersion: z.number().int().positive(),
    model: z.string().trim().min(1).max(200),
    auditedTaskIds: z.array(z.number().int().positive()).min(1).max(51),
    recommendations: z.array(relationshipAuditRecommendationSchema).max(50),
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

const claimedAgentMutationFields = {
  claimToken: z
    .string()
    .min(32)
    .max(256)
    .describe("Secret claim token returned by claim_task."),
  version: z
    .number()
    .int()
    .positive()
    .describe("Latest task version returned by the preceding operation."),
};

export const updateClaimedAgentTaskRequestSchema = z
  .object({
    ...claimedAgentMutationFields,
    title: titleField.optional().describe("Replace the task title."),
    priority: prioritySchema.optional().describe("Replace task priority."),
    effort: effortSchema.optional().describe("Replace the effort estimate."),
    evidenceState: evidenceStateSchema
      .optional()
      .describe("Replace the evidence classification."),
    finding: markdownField.optional().describe("Replace the finding Markdown."),
    description: markdownField
      .optional()
      .describe("Replace the intended-result Markdown."),
    research: notesSchema
      .optional()
      .describe(
        "Replace all research notes; do not combine with appendResearch.",
      ),
    appendResearch: notesSchema
      .optional()
      .describe(
        "Append exact-deduplicated research notes while preserving existing notes.",
      ),
    plannedValidation: notesSchema
      .optional()
      .describe(
        "Replace all planned validation; do not combine with appendPlannedValidation.",
      ),
    appendPlannedValidation: notesSchema
      .optional()
      .describe("Append planned checks while preserving existing checks."),
    tags: tagsSchema.optional().describe("Replace all task tags."),
    userSources: z
      .array(userSourceReferenceInputSchema)
      .max(50)
      .optional()
      .describe(
        "Replace all user-added sources; do not combine with addUserSources.",
      ),
    addUserSources: z
      .array(userSourceReferenceInputSchema)
      .max(50)
      .optional()
      .describe("Add new exact-deduplicated user sources."),
  })
  .strict()
  .superRefine((input, context) => {
    for (const [replaceField, appendField] of [
      ["research", "appendResearch"],
      ["plannedValidation", "appendPlannedValidation"],
      ["userSources", "addUserSources"],
    ] as const) {
      if (
        input[replaceField] !== undefined &&
        input[appendField] !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: [appendField],
          message: `Use either ${replaceField} or ${appendField}, not both.`,
        });
      }
    }
  })
  .refine(
    (input) =>
      [
        "title",
        "priority",
        "effort",
        "evidenceState",
        "finding",
        "description",
        "research",
        "appendResearch",
        "plannedValidation",
        "appendPlannedValidation",
        "tags",
        "userSources",
        "addUserSources",
      ].some((field) => input[field as keyof typeof input] !== undefined),
    {
      message: "Provide at least one task field to update.",
      path: ["update"],
    },
  );

export const transitionClaimedAgentTaskRequestSchema = z
  .object({
    ...claimedAgentMutationFields,
    status: statusSchema.describe("Permitted lifecycle status to move into."),
    reason: z
      .string()
      .trim()
      .max(10_000)
      .optional()
      .describe("Required explanation for blocking, dismissal, or reopening."),
  })
  .strict();

export const dismissAgentTaskRequestSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, "Enter a dismissal reason.")
      .max(10_000)
      .describe("Required reason for dismissing this unclaimed task."),
  })
  .strict();

export const recordClaimedAgentTaskValidationRequestSchema = z
  .object({
    ...claimedAgentMutationFields,
    type: validationTypeSchema.describe("Kind of validation performed."),
    outcome: validationOutcomeSchema.describe("Observed validation outcome."),
    notes: z
      .string()
      .trim()
      .max(100_000)
      .default("")
      .describe("Concise validation notes."),
    evidence: z
      .string()
      .trim()
      .max(100_000)
      .default("")
      .describe("Actual command, result, or other validation evidence."),
    supersedesId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Validation record ID corrected by this new record."),
  })
  .strict();

const handoffValidationSchema = recordClaimedAgentTaskValidationRequestSchema
  .omit({ claimToken: true, version: true })
  .describe("Optional actual validation result to record before release.");

export const handoffClaimedAgentTaskRequestSchema = z
  .object({
    ...claimedAgentMutationFields,
    finding: markdownField
      .optional()
      .describe("Replace the current finding before release."),
    addFiles: z
      .array(sourceFileSchema)
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Add exact-deduplicated file references while preserving existing files.",
      ),
    appendResearch: notesSchema
      .min(1)
      .optional()
      .describe("Append exact-deduplicated research notes before release."),
    appendPlannedValidation: notesSchema
      .min(1)
      .optional()
      .describe("Append planned checks before release."),
    validation: handoffValidationSchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      [
        "finding",
        "addFiles",
        "appendResearch",
        "appendPlannedValidation",
        "validation",
      ].some((field) => input[field as keyof typeof input] !== undefined),
    {
      message: "Provide at least one handoff field to save.",
      path: ["handoff"],
    },
  );

export const createSubtaskRequestSchema = z
  .object({
    version: z.number().int().positive(),
    title: titleField,
  })
  .strict();

export const taskBreakdownTemplateSchema = z.enum([
  "bug",
  "feature",
  "research",
  "migration",
]);

export const createTaskBreakdownRequestSchema = z
  .object({
    version: z.number().int().positive(),
    template: taskBreakdownTemplateSchema,
  })
  .strict();

export const createAgentTaskRequestSchema = z
  .object({
    idempotencyKey: z
      .string()
      .uuid()
      .describe(
        "Caller-generated UUID; reuse it only when retrying this exact creation request.",
      ),
    parentId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Optional parent Actionable ID. Omit for a top-level task; provide it for a direct subtask.",
      ),
    workItemId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Top-level feature or bug Actionable that authorizes direct-subtask creation. Required with parentId and must identify that parent.",
      ),
    projectId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Project ID; required only for a top-level task."),
    repositoryId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Repository ID; required only for a top-level task."),
    worktreeId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Worktree ID; required with projectId and repositoryId for an existing top-level scope.",
      ),
    repositoryPath: z
      .string()
      .trim()
      .min(1, "Enter the local repository path.")
      .max(4_096)
      .refine(
        (value) => /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value),
        "Enter an absolute Windows path.",
      )
      .optional()
      .describe(
        "Local Git repository or worktree path used to resolve or provision a top-level scope.",
      ),
    ensureScope: z
      .literal(true)
      .optional()
      .describe(
        "Set true with repositoryPath to create missing project, repository, or worktree scope records.",
      ),
    title: titleField.describe("Clear title for the new task."),
    priority: prioritySchema
      .default("Unset")
      .describe("Optional task priority."),
    description: markdownField
      .default("")
      .describe("Optional intended-result Markdown."),
    effort: effortSchema
      .default("Unknown")
      .describe("Optional effort estimate."),
    plannedValidation: notesSchema
      .default([])
      .describe("Optional checks planned for this task."),
  })
  .strict()
  .superRefine((input, context) => {
    const scopeFields = ["projectId", "repositoryId", "worktreeId"] as const;
    const hasScopeIds = scopeFields.some((field) => input[field] !== undefined);
    const hasRepositoryPlacement =
      input.repositoryPath !== undefined || input.ensureScope !== undefined;
    if (input.parentId === undefined) {
      if (input.workItemId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["workItemId"],
          message: "workItemId must be omitted for a top-level task.",
        });
      }
      if (hasScopeIds && hasRepositoryPlacement) {
        for (const field of ["repositoryPath", "ensureScope"] as const) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} must be omitted when scope IDs are provided.`,
          });
        }
        return;
      }
      if (hasScopeIds) {
        for (const field of scopeFields) {
          if (input[field] === undefined) {
            context.addIssue({
              code: "custom",
              path: [field],
              message: `${field} is required with the other scope IDs.`,
            });
          }
        }
        return;
      }
      if (hasRepositoryPlacement) {
        if (input.repositoryPath === undefined) {
          context.addIssue({
            code: "custom",
            path: ["repositoryPath"],
            message: "repositoryPath is required when ensureScope is true.",
          });
        }
        if (input.ensureScope !== true) {
          context.addIssue({
            code: "custom",
            path: ["ensureScope"],
            message:
              "Set ensureScope to true to provision scope from repositoryPath.",
          });
        }
        return;
      }
      for (const field of scopeFields) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for an existing top-level scope.`,
        });
      }
      return;
    }
    if (input.workItemId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["workItemId"],
        message: "workItemId is required with parentId.",
      });
    }
    for (const field of [
      ...scopeFields,
      "repositoryPath",
      "ensureScope",
    ] as const) {
      if (input[field] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be omitted when parentId supplies the task scope.`,
        });
      }
    }
  });

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
export type UserSourceReferenceInput = z.infer<
  typeof userSourceReferenceInputSchema
>;
export type UserSourceReference = z.infer<typeof userSourceReferenceSchema>;
export type ValidationType = z.infer<typeof validationTypeSchema>;
export type ValidationOutcome = z.infer<typeof validationOutcomeSchema>;
export type ValidationRecord = z.infer<typeof validationRecordSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type RelatedActionable = z.infer<typeof relatedActionableSchema>;
export type HierarchyRelationship = z.infer<typeof hierarchyRelationshipSchema>;
export type DependencyState = z.infer<typeof dependencyStateSchema>;
export type DependencyRelationship = z.infer<
  typeof dependencyRelationshipSchema
>;
export type StatusProvenance = z.infer<typeof statusProvenanceSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type ActionableSummary = z.infer<typeof actionableSummarySchema>;
export type ActionableDetail = z.infer<typeof actionableDetailSchema>;
export type ActionablesListResponse = z.infer<
  typeof actionablesListResponseSchema
>;
export type ScopeOptionsResponse = z.infer<typeof scopeOptionsResponseSchema>;
export type CreateRepositoryRequest = z.infer<
  typeof createRepositoryRequestSchema
>;
export type CreateRepositoryResponse = z.infer<
  typeof createRepositoryResponseSchema
>;
export type ActionableQuery = z.infer<typeof actionableQuerySchema>;
export type ActionableSort = z.infer<typeof actionableSortSchema>;
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
export type AgentTaskSummary = z.infer<typeof agentTaskSummarySchema>;
export type ListAgentTasksRequest = z.infer<typeof listAgentTasksRequestSchema>;
export type ListAgentTasksResponse = z.infer<
  typeof listAgentTasksResponseSchema
>;
export type ClaimAgentTaskRequest = z.infer<typeof claimAgentTaskRequestSchema>;
export type ClaimAgentTaskResponse = z.infer<
  typeof claimAgentTaskResponseSchema
>;
export type RecoverAgentTaskClaimRequest = z.infer<
  typeof recoverAgentTaskClaimRequestSchema
>;
export type RecoverAgentTaskClaimResponse = z.infer<
  typeof recoverAgentTaskClaimResponseSchema
>;
export type RenewAgentTaskClaimRequest = z.infer<
  typeof renewAgentTaskClaimRequestSchema
>;
export type RenewAgentTaskClaimResponse = z.infer<
  typeof renewAgentTaskClaimResponseSchema
>;
export type ReleaseAgentTaskClaimRequest = z.infer<
  typeof releaseAgentTaskClaimRequestSchema
>;
export type ReleaseAgentTaskClaimResponse = z.infer<
  typeof releaseAgentTaskClaimResponseSchema
>;
export type ForceReleaseAgentClaimRequest = z.infer<
  typeof forceReleaseAgentClaimRequestSchema
>;
export type ArchiveMutationRequest = z.infer<
  typeof archiveMutationRequestSchema
>;
export type ArchiveTargetKind = z.infer<typeof archiveTargetKindSchema>;
export type ArchiveImpactResponse = z.infer<typeof archiveImpactResponseSchema>;
export type CreateActionableRequest = z.infer<
  typeof createActionableRequestSchema
>;
export type UpdateActionableRequest = z.infer<
  typeof updateActionableRequestSchema
>;
export type GroomActionableNotesRequest = z.infer<
  typeof groomActionableNotesRequestSchema
>;
export type HelperAgentSettings = z.infer<typeof helperAgentSettingsSchema>;
export type NoteGroomerModel = z.infer<typeof noteGroomerModelSchema>;
export type AssistantReasoningEffort = z.infer<
  typeof assistantReasoningEffortSchema
>;
export type UpdateHelperAgentSettingsRequest = z.infer<
  typeof updateHelperAgentSettingsRequestSchema
>;
export type AgentIntegrationComponent = z.infer<
  typeof agentIntegrationComponentSchema
>;
export type AgentIntegrationSettings = z.infer<
  typeof agentIntegrationSettingsSchema
>;
export type InstallAgentIntegrationRequest = z.infer<
  typeof installAgentIntegrationRequestSchema
>;
export type AgentIntegrationInstallResponse = z.infer<
  typeof agentIntegrationInstallResponseSchema
>;
export type GroomActionableNotesProposal = z.infer<
  typeof groomActionableNotesProposalSchema
>;
export type GroomActionableNotesResponse = z.infer<
  typeof groomActionableNotesResponseSchema
>;
export type AuditActionableRelationshipsRequest = z.infer<
  typeof auditActionableRelationshipsRequestSchema
>;
export type RelationshipAuditRecommendation = z.infer<
  typeof relationshipAuditRecommendationSchema
>;
export type RelationshipAuditProposal = z.infer<
  typeof relationshipAuditProposalSchema
>;
export type RelationshipAuditResponse = z.infer<
  typeof relationshipAuditResponseSchema
>;
export type StatusTransitionRequest = z.infer<
  typeof statusTransitionRequestSchema
>;
export type CreateValidationRecordRequest = z.infer<
  typeof createValidationRecordRequestSchema
>;
export type UpdateClaimedAgentTaskRequest = z.infer<
  typeof updateClaimedAgentTaskRequestSchema
>;
export type TransitionClaimedAgentTaskRequest = z.infer<
  typeof transitionClaimedAgentTaskRequestSchema
>;
export type DismissAgentTaskRequest = z.infer<
  typeof dismissAgentTaskRequestSchema
>;
export type RecordClaimedAgentTaskValidationRequest = z.infer<
  typeof recordClaimedAgentTaskValidationRequestSchema
>;
export type HandoffClaimedAgentTaskRequest = z.infer<
  typeof handoffClaimedAgentTaskRequestSchema
>;
export type CreateSubtaskRequest = z.infer<typeof createSubtaskRequestSchema>;
export type TaskBreakdownTemplate = z.infer<typeof taskBreakdownTemplateSchema>;
export type CreateTaskBreakdownRequest = z.infer<
  typeof createTaskBreakdownRequestSchema
>;
export type CreateAgentTaskRequest = z.infer<
  typeof createAgentTaskRequestSchema
>;
export type SetParentRequest = z.infer<typeof setParentRequestSchema>;
export type DetachParentRequest = z.infer<typeof detachParentRequestSchema>;
export type CreateDependencyRequest = z.infer<
  typeof createDependencyRequestSchema
>;
export type DependencyActionRequest = z.infer<
  typeof dependencyActionRequestSchema
>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type ActionableDetailResponse = z.infer<
  typeof actionableDetailResponseSchema
>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type SeedDocument = z.infer<typeof seedDocumentSchema>;
export type PortableDocument = z.infer<typeof portableDocumentSchema>;
export type PortableActionable = PortableDocument["actionables"][number];
export type RelationshipSuggestion = z.infer<
  typeof relationshipSuggestionSchema
>;
export type ImportClassification = z.infer<typeof importClassificationSchema>;
export type ImportPreviewItem = z.infer<typeof importPreviewItemSchema>;
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;
export type PrepareImportCommitRequest = z.infer<
  typeof prepareImportCommitRequestSchema
>;
export type PrepareImportCommitResponse = z.infer<
  typeof prepareImportCommitResponseSchema
>;
export type CommitImportRequest = z.infer<typeof commitImportRequestSchema>;
export type ImportCommitResponse = z.infer<typeof importCommitResponseSchema>;
