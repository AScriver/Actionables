CREATE TABLE "AgentTaskClaim" (
    "actionableId" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "claimTokenHash" TEXT NOT NULL,
    "leaseExpiresAt" DATETIME NOT NULL,
    "claimedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentTaskClaim_actionableId_fkey"
        FOREIGN KEY ("actionableId") REFERENCES "Actionable" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentTaskClaim_claimTokenHash_key"
ON "AgentTaskClaim"("claimTokenHash");

CREATE INDEX "AgentTaskClaim_agentId_leaseExpiresAt_idx"
ON "AgentTaskClaim"("agentId", "leaseExpiresAt");
