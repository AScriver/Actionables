-- Add optimistic concurrency and editable triage fields without rewriting imported evidence.
ALTER TABLE "Actionable" ADD COLUMN "evidenceState" TEXT NOT NULL DEFAULT 'Unclassified';
ALTER TABLE "Actionable" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Actionable" ADD COLUMN "userSourcesJson" JSONB NOT NULL DEFAULT '[]';

-- Status history is written in the same transaction as each status change.
CREATE TABLE "ActionableStatusHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actionableId" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActionableStatusHistory_actionableId_fkey" FOREIGN KEY ("actionableId") REFERENCES "Actionable" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ActionableStatusHistory_actionableId_occurredAt_idx"
ON "ActionableStatusHistory"("actionableId", "occurredAt");
