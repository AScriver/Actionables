ALTER TABLE "Project" ADD COLUMN "importBaselineJson" JSONB;
ALTER TABLE "Repository" ADD COLUMN "importBaselineJson" JSONB;
ALTER TABLE "Worktree" ADD COLUMN "importBaselineJson" JSONB;
ALTER TABLE "Actionable" ADD COLUMN "importBaselineJson" JSONB;
ALTER TABLE "Actionable" ADD COLUMN "fieldOwnershipJson" JSONB;
ALTER TABLE "HierarchyRelationship" ADD COLUMN "provenance" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "DependencyRelationship" ADD COLUMN "provenance" TEXT NOT NULL DEFAULT 'user';

CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentDigest" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "sourceName" TEXT,
    "summaryJson" JSONB NOT NULL,
    "committedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ImportRun_committedAt_idx" ON "ImportRun"("committedAt");
