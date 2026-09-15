import type { Prisma } from "./generated/prisma/client.js";

/** Resolves the current top-level task through active parent relationships. */
export async function getHierarchyRoot(
  client: Prisma.TransactionClient,
  id: string,
) {
  const roots = await client.$queryRaw<
    Array<{ id: string; sourceOrdinal: number }>
  >`
    WITH RECURSIVE ancestors(id) AS (
      SELECT ${id}
      UNION
      SELECT edge.parentId FROM HierarchyRelationship edge
      JOIN ancestors ON edge.childId = ancestors.id
      WHERE edge.detachedAt IS NULL
    )
    SELECT task.id, task.sourceOrdinal FROM Actionable task
    JOIN ancestors ON ancestors.id = task.id
    WHERE NOT EXISTS (
      SELECT 1 FROM HierarchyRelationship edge
      WHERE edge.childId = task.id AND edge.detachedAt IS NULL
    )
  `;
  if (roots.length !== 1) throw new Error("The hierarchy has no unique root.");
  return roots[0]!;
}

/** Returns a task and each attached descendant once, including archived tasks. */
export async function getHierarchyTasks(
  client: Prisma.TransactionClient,
  id: string,
) {
  return client.$queryRaw<Array<{ id: string; sourceOrdinal: number }>>`
    WITH RECURSIVE descendants(id) AS (
      SELECT ${id}
      UNION
      SELECT edge.childId FROM HierarchyRelationship edge
      JOIN descendants ON edge.parentId = descendants.id
      WHERE edge.detachedAt IS NULL
    )
    SELECT task.id, task.sourceOrdinal FROM Actionable task
    JOIN descendants ON descendants.id = task.id
    ORDER BY task.sourceOrdinal
  `;
}
