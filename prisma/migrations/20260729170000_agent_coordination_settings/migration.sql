ALTER TABLE "HelperAgentSettings" ADD COLUMN "agentClaimLeaseMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "HelperAgentSettings" ADD COLUMN "agentClaimExpiryWarningMinutes" INTEGER NOT NULL DEFAULT 10;
