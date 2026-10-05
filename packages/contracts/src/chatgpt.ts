import { z } from "zod/v4";
import {
  actionableDetailSchema,
  activityEventSchema,
  dependencyStateSchema,
  relatedActionableSchema,
  scopeSchema,
  statusHistoryEntrySchema,
  validationRecordSchema,
} from "./index.js";

// ChatGPT wire/presentation contracts only. Domain state comes from getActionable.
export const reviewResourceUri = "ui://actionables/review/v1.html";
const publicId = z
  .number()
  .int()
  .positive()
  .describe("Public numeric Actionable ID.");
const version = z
  .number()
  .int()
  .positive()
  .describe("Exact version from get_actionable.");
const contentHash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe(
    "Content hash from the first page; keep it for every continuation.",
  );
const readInputs = {
  id: publicId,
  includeArchived: z
    .boolean()
    .default(false)
    .describe(
      "Explicitly include archived tasks or their work-item root without restoring anything.",
    ),
};
export const getActionableReviewRequestSchema = z
  .object({
    ...readInputs,
    version: version.optional(),
    offset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Start at 0, then use only the returned nextOffset."),
    contentHash: contentHash.optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.offset === 0 ||
      (input.version !== undefined && input.contentHash !== undefined),
    {
      message:
        "Continuations require version and contentHash from the first page.",
      path: ["offset"],
    },
  );
export const renderActionableReviewRequestSchema = z
  .object({
    ...readInputs,
    version,
    contentHash: contentHash.optional(),
  })
  .strict();

const scopeNames = scopeSchema.pick({
  projectName: true,
  repositoryName: true,
  worktreeName: true,
});
const reference = relatedActionableSchema.pick({
  id: true,
  title: true,
  status: true,
  version: true,
  archiveState: true,
});
const dependency = reference.extend({
  state: dependencyStateSchema,
  isSatisfied: z.boolean(),
  waiverReason: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export const reviewContentSchema = z
  .object({
    title: z.array(z.string()),
    scope: z.array(scopeNames),
    parent: z.array(reference),
    root: z.array(reference),
    subtasks: z.array(reference),
    blockedBy: z.array(dependency),
    blocks: z.array(dependency),
    validationRecords: z.array(validationRecordSchema),
    finding: z.array(z.string()),
    description: z.array(z.string()),
    manualBlocker: z.array(z.string()),
    plannedValidation: z.array(z.string()),
    resolution: z.array(z.string()),
    research: z.array(z.string()),
    statusHistory: z.array(statusHistoryEntrySchema),
    activity: z.array(
      activityEventSchema.omit({ context: true, actionable: true }),
    ),
  })
  .strict();
export const reviewFieldSchema = reviewContentSchema.keyof();
const textProperty = z.enum([
  "id",
  "title",
  "status",
  "projectName",
  "repositoryName",
  "worktreeName",
  "waiverReason",
  "createdAt",
  "type",
  "outcome",
  "notes",
  "evidence",
  "origin",
  "recordedAt",
  "supersedesId",
  "supersededById",
  "summary",
  "previousStatus",
  "newStatus",
  "occurredAt",
]);
const itemPosition = {
  field: reviewFieldSchema,
  index: z.number().int().nonnegative(),
};
export const reviewItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...itemPosition,
      kind: z.literal("value"),
      value: z.union([z.string(), z.record(z.string(), z.json())]),
    })
    .strict(),
  z
    .object({
      ...itemPosition,
      kind: z.literal("text"),
      property: textProperty.optional(),
      offset: z.number().int().nonnegative(),
      totalLength: z.number().int().nonnegative(),
      text: z.string().max(1_000),
    })
    .strict(),
]);
export const reviewSummarySchema = actionableDetailSchema
  .pick({
    id: true,
    workItemId: true,
    status: true,
    priority: true,
    effort: true,
    evidenceState: true,
    version: true,
    createdAt: true,
    updatedAt: true,
    archiveState: true,
    directTaskProgress: true,
    isDependencyBlocked: true,
    isEffectivelyBlocked: true,
    unresolvedDependencyCount: true,
    hasQualifyingValidation: true,
    readiness: true,
    completionEligibility: true,
  })
  .extend({
    title: z.string().max(240),
    scope: scopeNames.extend({
      projectName: z.string().max(240),
      repositoryName: z.string().max(240),
      worktreeName: z.string().max(240),
    }),
    metadataTruncated: z.array(z.string()).max(4),
  });
export const actionableReviewPageSchema = z
  .object({
    summary: reviewSummarySchema,
    includeArchived: z.boolean(),
    contentHash,
    fieldCounts: z.record(reviewFieldSchema, z.number().int().nonnegative()),
    items: z.array(reviewItemSchema).max(40),
    offset: z.number().int().nonnegative(),
    totalItems: z.number().int().nonnegative(),
    remainingItems: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    complete: z.boolean(),
  })
  .strict();
export type ReviewContent = z.infer<typeof reviewContentSchema>;
export type ReviewItem = z.infer<typeof reviewItemSchema>;
export type ActionableReviewPage = z.infer<typeof actionableReviewPageSchema>;
