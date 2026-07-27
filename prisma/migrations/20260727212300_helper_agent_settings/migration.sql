CREATE TABLE "HelperAgentSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteGroomerPrompt" TEXT NOT NULL,
    "relationshipAuditorPrompt" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL
);
