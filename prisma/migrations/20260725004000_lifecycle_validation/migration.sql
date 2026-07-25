-- AlterTable
ALTER TABLE "Actionable" ADD COLUMN "manualBlockerMd" TEXT;
ALTER TABLE "Actionable" ADD COLUMN "dismissalReasonMd" TEXT;
ALTER TABLE "Actionable" ADD COLUMN "completionOverrideMd" TEXT;

-- CreateTable
CREATE TABLE "ValidationRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actionableId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "notesMd" TEXT NOT NULL,
    "evidenceMd" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedesId" TEXT,
    CONSTRAINT "ValidationRecord_actionableId_fkey" FOREIGN KEY ("actionableId") REFERENCES "Actionable" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ValidationRecord_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "ValidationRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actionableId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "metadataJson" JSONB NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActivityEvent_actionableId_fkey" FOREIGN KEY ("actionableId") REFERENCES "Actionable" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserSourceReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actionableId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "locator" TEXT NOT NULL,
    "label" TEXT,
    "provenance" TEXT NOT NULL DEFAULT 'user-added',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" DATETIME,
    CONSTRAINT "UserSourceReference_actionableId_fkey" FOREIGN KEY ("actionableId") REFERENCES "Actionable" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Preserve existing user-added sources while moving them to timestamped records.
INSERT INTO "UserSourceReference" (
    "id", "actionableId", "type", "locator", "label", "provenance", "createdAt"
)
SELECT
    lower(hex(randomblob(16))),
    actionable."id",
    json_extract(source.value, '$.type'),
    json_extract(source.value, '$.locator'),
    nullif(json_extract(source.value, '$.label'), ''),
    'user-added',
    actionable."createdAt"
FROM "Actionable" AS actionable, json_each(actionable."userSourcesJson") AS source
WHERE json_valid(actionable."userSourcesJson")
  AND json_type(actionable."userSourcesJson") = 'array'
  AND json_extract(source.value, '$.locator') IS NOT NULL;

-- Backfill the existing status history into the unified activity timeline.
INSERT INTO "ActivityEvent" (
    "id", "actionableId", "type", "summary", "metadataJson", "occurredAt"
)
SELECT
    lower(hex(randomblob(16))),
    history."actionableId",
    'status-transition',
    CASE
      WHEN history."previousStatus" IS NULL
        THEN 'Created as ' || history."newStatus"
      ELSE history."previousStatus" || ' → ' || history."newStatus"
    END,
    json_object(
      'previousStatus', coalesce(history."previousStatus", ''),
      'newStatus', history."newStatus",
      'origin', history."origin"
    ),
    history."occurredAt"
FROM "ActionableStatusHistory" AS history;

-- CreateIndex
CREATE UNIQUE INDEX "ValidationRecord_supersedesId_key" ON "ValidationRecord"("supersedesId");
CREATE INDEX "ValidationRecord_actionableId_recordedAt_idx" ON "ValidationRecord"("actionableId", "recordedAt");
CREATE INDEX "ActivityEvent_actionableId_occurredAt_idx" ON "ActivityEvent"("actionableId", "occurredAt");
CREATE INDEX "UserSourceReference_actionableId_createdAt_idx" ON "UserSourceReference"("actionableId", "createdAt");
