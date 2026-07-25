-- Hierarchy and dependency are intentionally separate relationship models.
CREATE TABLE "HierarchyRelationship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detachedAt" DATETIME,
    CONSTRAINT "HierarchyRelationship_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Actionable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "HierarchyRelationship_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Actionable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "HierarchyRelationship_not_self" CHECK ("parentId" <> "childId")
);

CREATE TABLE "DependencyRelationship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dependentId" TEXT NOT NULL,
    "prerequisiteId" TEXT NOT NULL,
    "waivedAt" DATETIME,
    "waiverReason" TEXT,
    "removedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DependencyRelationship_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "Actionable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DependencyRelationship_prerequisiteId_fkey" FOREIGN KEY ("prerequisiteId") REFERENCES "Actionable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DependencyRelationship_not_self" CHECK ("dependentId" <> "prerequisiteId")
);

CREATE INDEX "HierarchyRelationship_parentId_detachedAt_idx"
ON "HierarchyRelationship"("parentId", "detachedAt");
CREATE INDEX "HierarchyRelationship_childId_detachedAt_idx"
ON "HierarchyRelationship"("childId", "detachedAt");
CREATE UNIQUE INDEX "HierarchyRelationship_active_child_key"
ON "HierarchyRelationship"("childId") WHERE "detachedAt" IS NULL;
CREATE UNIQUE INDEX "HierarchyRelationship_active_pair_key"
ON "HierarchyRelationship"("parentId", "childId") WHERE "detachedAt" IS NULL;

CREATE INDEX "DependencyRelationship_dependentId_removedAt_idx"
ON "DependencyRelationship"("dependentId", "removedAt");
CREATE INDEX "DependencyRelationship_prerequisiteId_removedAt_idx"
ON "DependencyRelationship"("prerequisiteId", "removedAt");
CREATE UNIQUE INDEX "DependencyRelationship_active_pair_key"
ON "DependencyRelationship"("dependentId", "prerequisiteId")
WHERE "removedAt" IS NULL;

-- SQLite serializes writes; this trigger also performs cycle validation at the
-- database write boundary so two concurrent requests cannot commit a cycle.
CREATE TRIGGER "DependencyRelationship_no_cycle_insert"
BEFORE INSERT ON "DependencyRelationship"
WHEN NEW."removedAt" IS NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE reachable("id") AS (
      SELECT edge."prerequisiteId"
      FROM "DependencyRelationship" AS edge
      WHERE edge."dependentId" = NEW."prerequisiteId"
        AND edge."removedAt" IS NULL
      UNION
      SELECT edge."prerequisiteId"
      FROM "DependencyRelationship" AS edge
      JOIN reachable ON edge."dependentId" = reachable."id"
      WHERE edge."removedAt" IS NULL
    )
    SELECT 1 FROM reachable WHERE "id" = NEW."dependentId"
  ) THEN RAISE(ABORT, 'DEPENDENCY_CYCLE') END;
END;

CREATE TRIGGER "DependencyRelationship_no_cycle_restore"
BEFORE UPDATE OF "removedAt" ON "DependencyRelationship"
WHEN OLD."removedAt" IS NOT NULL AND NEW."removedAt" IS NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE reachable("id") AS (
      SELECT edge."prerequisiteId"
      FROM "DependencyRelationship" AS edge
      WHERE edge."dependentId" = NEW."prerequisiteId"
        AND edge."removedAt" IS NULL
        AND edge."id" <> NEW."id"
      UNION
      SELECT edge."prerequisiteId"
      FROM "DependencyRelationship" AS edge
      JOIN reachable ON edge."dependentId" = reachable."id"
      WHERE edge."removedAt" IS NULL
        AND edge."id" <> NEW."id"
    )
    SELECT 1 FROM reachable WHERE "id" = NEW."dependentId"
  ) THEN RAISE(ABORT, 'DEPENDENCY_CYCLE') END;
END;

-- Preserve the reviewed one-level seed hierarchy. Legacy blocked-by values are
-- suggestions and intentionally are not promoted to dependency edges.
INSERT INTO "HierarchyRelationship" ("id", "parentId", "childId", "createdAt")
SELECT
    lower(hex(randomblob(16))),
    parent."id",
    child."id",
    child."createdAt"
FROM "Actionable" AS child
JOIN "Actionable" AS parent
  ON parent."sourceOrdinal" = child."parentOrdinal"
WHERE child."parentOrdinal" IS NOT NULL;

INSERT INTO "ActivityEvent" (
    "id", "actionableId", "type", "summary", "metadataJson", "occurredAt"
)
SELECT
    lower(hex(randomblob(16))),
    relationship."childId",
    'hierarchy-attached',
    'Imported as a subtask',
    json_object(
      'hierarchyRelationshipId', relationship."id",
      'parentActionableId', relationship."parentId",
      'origin', 'reviewed-seed-import'
    ),
    relationship."createdAt"
FROM "HierarchyRelationship" AS relationship;

INSERT INTO "ActivityEvent" (
    "id", "actionableId", "type", "summary", "metadataJson", "occurredAt"
)
SELECT
    lower(hex(randomblob(16))),
    relationship."parentId",
    'hierarchy-attached',
    'Imported subtask relationship',
    json_object(
      'hierarchyRelationshipId', relationship."id",
      'childActionableId', relationship."childId",
      'origin', 'reviewed-seed-import'
    ),
    relationship."createdAt"
FROM "HierarchyRelationship" AS relationship;
