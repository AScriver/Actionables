ALTER TABLE "Project" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Project" ADD COLUMN "archivedAt" DATETIME;

ALTER TABLE "Repository" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Repository" ADD COLUMN "archivedAt" DATETIME;

ALTER TABLE "Worktree" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Worktree" ADD COLUMN "archivedAt" DATETIME;

ALTER TABLE "Actionable" ADD COLUMN "archivedAt" DATETIME;

CREATE INDEX "Actionable_archivedAt_status_updatedAt_idx"
ON "Actionable"("archivedAt", "status", "updatedAt");

CREATE INDEX "Actionable_projectId_repositoryId_worktreeId_archivedAt_idx"
ON "Actionable"("projectId", "repositoryId", "worktreeId", "archivedAt");
