-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "localPath" TEXT,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Repository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Worktree" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "localPath" TEXT,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Worktree_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Worktree_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Actionable" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalKey" TEXT NOT NULL,
    "sourceOrdinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Inbox',
    "statusProvenance" TEXT NOT NULL,
    "sourceStatusSuggestion" TEXT,
    "effort" TEXT NOT NULL,
    "updatedLabel" TEXT NOT NULL,
    "finding" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "researchJson" JSONB NOT NULL,
    "validationJson" JSONB NOT NULL,
    "filesJson" JSONB NOT NULL,
    "tagsJson" JSONB NOT NULL,
    "blockedByOrdinalsJson" JSONB NOT NULL,
    "blocksOrdinalsJson" JSONB NOT NULL,
    "parentOrdinal" INTEGER,
    "childOrdinalsJson" JSONB NOT NULL,
    "importProvider" TEXT NOT NULL,
    "sourceContainerId" TEXT NOT NULL,
    "sourceThread" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "rawFragmentJson" JSONB NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "worktreeId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Actionable_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Actionable_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Actionable_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_externalKey_key" ON "Project"("externalKey");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_externalKey_key" ON "Repository"("externalKey");

-- CreateIndex
CREATE UNIQUE INDEX "Worktree_externalKey_key" ON "Worktree"("externalKey");

-- CreateIndex
CREATE UNIQUE INDEX "Actionable_externalKey_key" ON "Actionable"("externalKey");

-- CreateIndex
CREATE UNIQUE INDEX "Actionable_sourceOrdinal_key" ON "Actionable"("sourceOrdinal");

-- CreateIndex
CREATE INDEX "Actionable_projectId_worktreeId_sourceOrdinal_idx" ON "Actionable"("projectId", "worktreeId", "sourceOrdinal");

-- CreateIndex
CREATE INDEX "Actionable_priority_status_idx" ON "Actionable"("priority", "status");
