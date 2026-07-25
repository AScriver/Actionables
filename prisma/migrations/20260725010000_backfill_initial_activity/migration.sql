-- Older imported rows predate status history. Give each aggregate one truthful
-- initial event without rewriting imported source evidence.
INSERT INTO "ActionableStatusHistory" (
    "id", "actionableId", "previousStatus", "newStatus", "origin", "occurredAt"
)
SELECT
    lower(hex(randomblob(16))),
    actionable."id",
    NULL,
    actionable."status",
    CASE
      WHEN actionable."importProvider" = 'MANUAL' THEN 'legacy-manual'
      ELSE 'legacy-import'
    END,
    actionable."createdAt"
FROM "Actionable" AS actionable
WHERE NOT EXISTS (
    SELECT 1
    FROM "ActionableStatusHistory" AS history
    WHERE history."actionableId" = actionable."id"
);

INSERT INTO "ActivityEvent" (
    "id", "actionableId", "type", "summary", "metadataJson", "occurredAt"
)
SELECT
    lower(hex(randomblob(16))),
    history."actionableId",
    'status-transition',
    CASE
      WHEN history."origin" = 'legacy-import'
        THEN 'Imported as ' || history."newStatus"
      ELSE 'Created as ' || history."newStatus"
    END,
    json_object(
      'previousStatus', '',
      'newStatus', history."newStatus",
      'origin', history."origin"
    ),
    history."occurredAt"
FROM "ActionableStatusHistory" AS history
WHERE history."previousStatus" IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "ActivityEvent" AS activity
      WHERE activity."actionableId" = history."actionableId"
        AND activity."type" = 'status-transition'
        AND activity."occurredAt" = history."occurredAt"
  );
