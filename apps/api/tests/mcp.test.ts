import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrismaClient, type AppPrismaClient } from "../src/database.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const prismaCli = resolve(repoRoot, "node_modules/prisma/build/index.js");
const bearerToken = "test-mcp-token-with-at-least-thirty-two-characters";
const threadId = "019fa45f-581d-7bc0-afe3-a2b65171df62";
const agentId = `codex:${threadId}`;
const json = (value: unknown) => value as never;

let databasePath: string;
let prisma: AppPrismaClient;
let app: ReturnType<typeof buildApp>;
let address: string;
let scope: { projectId: string; repositoryId: string; worktreeId: string };
let nextOrdinal = 1;

async function createTask(overrides: { status?: string; title?: string } = {}) {
  const highest = await prisma.actionable.aggregate({
    _max: { sourceOrdinal: true },
  });
  const ordinal = Math.max(nextOrdinal, (highest._max.sourceOrdinal ?? 0) + 1);
  nextOrdinal = ordinal + 1;
  return prisma.actionable.create({
    data: {
      externalKey: `mcp-task-${ordinal}`,
      sourceOrdinal: ordinal,
      title: overrides.title ?? `MCP task ${ordinal}`,
      priority: "High",
      status: overrides.status ?? "Ready",
      statusProvenance: "MCP integration fixture.",
      effort: "S",
      evidenceState: "Confirmed",
      updatedLabel: "fixture",
      finding: "Initial finding",
      description: "Initial description",
      researchJson: json([]),
      validationJson: json(["Run the MCP integration test."]),
      filesJson: json([{ path: "apps/api/src/mcp.ts" }]),
      tagsJson: json(["mcp"]),
      userSourcesJson: json([]),
      blockedByOrdinalsJson: json([]),
      blocksOrdinalsJson: json([]),
      childOrdinalsJson: json([]),
      importProvider: "MANUAL",
      sourceContainerId: "",
      sourceThread: "",
      contentHash: "",
      rawFragmentJson: json({ fixture: true }),
      ...scope,
    },
  });
}

function threadMetadata(value: string) {
  return {
    threadId: value,
    "x-codex-turn-metadata": { thread_id: value },
  };
}

async function connectClient(
  token = bearerToken,
  requestThreadId: string | null = threadId,
) {
  const client = new Client({ name: "actionables-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${address}/mcp`),
    {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
          origin: address,
        },
      },
    },
  );
  await client.connect(transport);
  const callToolWithoutThread = client.callTool.bind(client);
  client.callTool = ((params, ...rest) =>
    callToolWithoutThread(
      requestThreadId
        ? { ...params, _meta: threadMetadata(requestThreadId) }
        : params,
      ...rest,
    )) as typeof client.callTool;
  return { client, transport };
}

function output<T>(value: unknown) {
  const result = value as CallToolResult;
  expect(result.isError).not.toBe(true);
  return result.structuredContent as T;
}

function errorOutput(value: unknown) {
  const result = value as CallToolResult;
  expect(result.isError).toBe(true);
  const parsed = JSON.parse(
    result.content.find((item) => item.type === "text")?.text ?? "{}",
  ) as Record<string, unknown>;
  expect(result.structuredContent).toEqual(parsed);
  expect(typeof parsed.retryable).toBe("boolean");
  expect(typeof parsed.nextAction).toBe("string");
  return parsed;
}

function describedProperties(
  schema: unknown,
  path = "input",
): Array<{ path: string; schema: Record<string, unknown> }> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const node = schema as Record<string, unknown>;
  const found: Array<{ path: string; schema: Record<string, unknown> }> = [];
  if (
    node.properties &&
    typeof node.properties === "object" &&
    !Array.isArray(node.properties)
  ) {
    for (const [name, property] of Object.entries(node.properties)) {
      if (!property || typeof property !== "object" || Array.isArray(property))
        continue;
      found.push({
        path: `${path}.${name}`,
        schema: property as Record<string, unknown>,
      });
      found.push(...describedProperties(property, `${path}.${name}`));
    }
  }
  found.push(...describedProperties(node.items, `${path}[]`));
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const alternatives = node[keyword];
    if (Array.isArray(alternatives)) {
      alternatives.forEach((alternative, index) => {
        found.push(
          ...describedProperties(alternative, `${path}.${keyword}[${index}]`),
        );
      });
    }
  }
  if (
    node.$defs &&
    typeof node.$defs === "object" &&
    !Array.isArray(node.$defs)
  ) {
    for (const [name, definition] of Object.entries(node.$defs)) {
      found.push(...describedProperties(definition, `${path}.$defs.${name}`));
    }
  }
  return found;
}

beforeAll(async () => {
  const databaseName = `mcp-${randomUUID()}.db`;
  databasePath = resolve(repoRoot, "data", databaseName);
  const databaseUrl = `file:./data/${databaseName}`;
  const databaseFile = await open(databasePath, "a");
  await databaseFile.close();
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
  prisma = createPrismaClient(databaseUrl);
  const project = await prisma.project.create({
    data: { externalKey: "mcp-project", name: "MCP Project" },
  });
  const repository = await prisma.repository.create({
    data: {
      externalKey: "mcp-repository",
      name: "MCP Repository",
      projectId: project.id,
    },
  });
  const worktree = await prisma.worktree.create({
    data: {
      externalKey: "mcp-worktree",
      name: "MCP Worktree",
      projectId: project.id,
      repositoryId: repository.id,
    },
  });
  scope = {
    projectId: project.id,
    repositoryId: repository.id,
    worktreeId: worktree.id,
  };
  app = buildApp({ prisma, mcpBearerToken: bearerToken });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  if (databasePath) {
    await Promise.all(
      ["", "-journal", "-shm", "-wal"].map((suffix) =>
        rm(`${databasePath}${suffix}`, { force: true }),
      ),
    );
  }
});

describe("Actionables MCP", () => {
  it("exposes exactly the bounded task tools through the official client", async () => {
    const { client, transport } = await connectClient();
    try {
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        [
          "actionables.create_task",
          "actionables.list_tasks",
          "actionables.get_task",
          "actionables.claim_task",
          "actionables.renew_task_claim",
          "actionables.update_task",
          "actionables.transition_task",
          "actionables.dismiss_task",
          "actionables.record_task_validation",
          "actionables.release_task",
        ].sort(),
      );
      for (const tool of tools) {
        const properties = describedProperties(tool.inputSchema);
        expect(properties.length, tool.name).toBeGreaterThan(0);
        for (const property of properties) {
          expect(
            property.schema.description,
            `${tool.name} ${property.path}`,
          ).toEqual(expect.any(String));
        }
      }
      const byName = Object.fromEntries(
        tools.map((tool) => [tool.name, tool.annotations]),
      );
      expect(byName["actionables.list_tasks"]).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(byName["actionables.create_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(byName["actionables.update_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(byName["actionables.transition_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(byName["actionables.dismiss_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
      expect(byName["actionables.release_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
    } finally {
      await transport.close();
    }
  });

  it("creates top-level and direct-child tasks and returns the same task on retry", async () => {
    const { client, transport } = await connectClient();
    try {
      const topLevelKey = randomUUID();
      const topLevelArguments = {
        idempotencyKey: topLevelKey,
        ...scope,
        title: "Agent-created top-level task",
        priority: "High",
        description: "Created through the single MCP task operation.",
        effort: "S",
        plannedValidation: ["Verify top-level creation."],
      };
      const topLevel = output<{
        id: number;
        recordId: string;
        title: string;
        priority: string;
        description: string;
        effort: string;
        plannedValidation: string[];
        version: number;
        parent: null;
        scope: typeof scope;
      }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: topLevelArguments,
        }),
      );
      expect(topLevel).toMatchObject({
        title: topLevelArguments.title,
        priority: "High",
        description: topLevelArguments.description,
        effort: "S",
        plannedValidation: topLevelArguments.plannedValidation,
        parent: null,
        scope,
      });
      const topLevelRetry = output<{ id: number; version: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: topLevelArguments,
        }),
      );
      expect(topLevelRetry).toEqual(
        expect.objectContaining({
          id: topLevel.id,
          version: topLevel.version,
        }),
      );

      const childKey = randomUUID();
      const childArguments = {
        idempotencyKey: childKey,
        parentId: topLevel.id,
        title: "Agent-created direct child",
        description: "Must inherit the parent scope.",
        effort: "M",
        plannedValidation: ["Verify direct hierarchy placement."],
      };
      const child = output<{
        id: number;
        title: string;
        parent: { id: number };
        scope: typeof scope;
        version: number;
      }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: childArguments,
        }),
      );
      expect(child).toMatchObject({
        title: childArguments.title,
        parent: { id: topLevel.id },
        scope,
      });
      const childRetry = output<{ id: number; version: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: childArguments,
        }),
      );
      expect(childRetry).toEqual(
        expect.objectContaining({ id: child.id, version: child.version }),
      );

      expect(
        await prisma.actionable.count({
          where: {
            title: {
              in: [topLevelArguments.title, childArguments.title],
            },
          },
        }),
      ).toBe(2);
      expect(
        await prisma.hierarchyRelationship.count({
          where: {
            parentId: topLevel.recordId,
            child: { sourceOrdinal: child.id },
            detachedAt: null,
          },
        }),
      ).toBe(1);
      expect(
        (
          await prisma.actionable.findUniqueOrThrow({
            where: { id: topLevel.recordId },
          })
        ).rawFragmentJson,
      ).toMatchObject({ creatorThreadId: threadId });
    } finally {
      await transport.close();
    }
  });

  it("dismisses only an unclaimed task created by the calling Codex thread", async () => {
    const { client, transport } = await connectClient();
    const other = await connectClient(
      bearerToken,
      "019fa45f-581d-7bc0-afe3-a2b65171df63",
    );
    const withoutThread = await connectClient(bearerToken, null);
    try {
      const createArguments = (title: string) => ({
        idempotencyKey: randomUUID(),
        ...scope,
        title,
      });
      const created = output<{ id: number; recordId: string; version: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: createArguments("Same-thread dismissal"),
        }),
      );
      const dismissed = output<{ status: string; version: number }>(
        await client.callTool({
          name: "actionables.dismiss_task",
          arguments: {
            id: created.id,
            reason: "Disposable task created during this Codex thread.",
          },
        }),
      );
      expect(dismissed).toMatchObject({
        status: "Dismissed",
        version: created.version + 1,
      });
      const stored = await prisma.actionable.findUniqueOrThrow({
        where: { id: created.recordId },
        include: {
          statusHistory: { orderBy: { occurredAt: "desc" }, take: 1 },
          activityEvents: { orderBy: { occurredAt: "desc" }, take: 1 },
        },
      });
      expect(stored).toMatchObject({
        status: "Dismissed",
        dismissalReasonMd: "Disposable task created during this Codex thread.",
      });
      expect(stored.statusHistory[0]).toMatchObject({
        previousStatus: "Inbox",
        newStatus: "Dismissed",
        origin: `agent:${agentId}`,
      });
      expect(stored.activityEvents[0]).toMatchObject({
        type: "dismissed",
        metadataJson: expect.objectContaining({
          reason: "Disposable task created during this Codex thread.",
          origin: `agent:${agentId}`,
        }),
      });

      const protectedTask = output<{
        id: number;
        recordId: string;
        version: number;
      }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: createArguments("Thread-protected dismissal"),
        }),
      );
      const wrongThread = errorOutput(
        await other.client.callTool({
          name: "actionables.dismiss_task",
          arguments: {
            id: protectedTask.id,
            reason: "Must not dismiss from another thread.",
          },
        }),
      );
      expect(wrongThread).toMatchObject({
        code: "CREATOR_THREAD_MISMATCH",
        retryable: false,
      });
      expect(
        (
          await prisma.actionable.findUniqueOrThrow({
            where: { id: protectedTask.recordId },
          })
        ).status,
      ).toBe("Inbox");

      const claimed = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: protectedTask.id,
            workItemId: protectedTask.id,
            version: protectedTask.version,
          },
        }),
      );
      const liveClaim = errorOutput(
        await client.callTool({
          name: "actionables.dismiss_task",
          arguments: {
            id: protectedTask.id,
            reason: "Claimed work must use transition_task.",
          },
        }),
      );
      expect(liveClaim).toMatchObject({
        code: "ALREADY_CLAIMED",
        retryable: true,
      });
      output(
        await client.callTool({
          name: "actionables.release_task",
          arguments: {
            id: protectedTask.id,
            claimToken: claimed.claim.claimToken,
          },
        }),
      );

      const missingThread = errorOutput(
        await withoutThread.client.callTool({
          name: "actionables.list_tasks",
          arguments: { view: "mine" },
        }),
      );
      expect(missingThread).toMatchObject({
        code: "THREAD_ID_REQUIRED",
        retryable: false,
      });
    } finally {
      await withoutThread.transport.close();
      await other.transport.close();
      await transport.close();
    }
  });

  it("atomically provisions and reuses scope from a local Git path", async () => {
    const { client, transport } = await connectClient();
    try {
      const before = {
        projects: await prisma.project.count(),
        repositories: await prisma.repository.count(),
        worktrees: await prisma.worktree.count(),
      };
      const argumentsValue = {
        idempotencyKey: randomUUID(),
        repositoryPath: repoRoot,
        ensureScope: true,
        title: "Task with automatically provisioned scope",
      };
      const created = output<{
        id: number;
        scope: {
          projectId: string;
          repositoryId: string;
          worktreeId: string;
        };
        scopeProvisioning: {
          ensured: true;
          repositoryPath: string;
          worktreePath: string;
          projectCreated: boolean;
          repositoryCreated: boolean;
          worktreeCreated: boolean;
        };
      }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: argumentsValue,
        }),
      );
      expect(created.scopeProvisioning).toMatchObject({
        ensured: true,
        projectCreated: true,
        repositoryCreated: true,
        worktreeCreated: true,
      });
      expect(created.scopeProvisioning.repositoryPath.toLowerCase()).toBe(
        repoRoot.toLowerCase(),
      );
      expect(await prisma.project.count()).toBe(before.projects + 1);
      expect(await prisma.repository.count()).toBe(before.repositories + 1);
      expect(await prisma.worktree.count()).toBe(before.worktrees + 1);

      const second = output<{
        scope: typeof created.scope;
        scopeProvisioning: typeof created.scopeProvisioning;
      }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            ...argumentsValue,
            idempotencyKey: randomUUID(),
            title: "Second task in automatically provisioned scope",
          },
        }),
      );
      expect(second.scope).toEqual(created.scope);
      expect(second.scopeProvisioning).toMatchObject({
        projectCreated: false,
        repositoryCreated: false,
        worktreeCreated: false,
      });
      expect(await prisma.project.count()).toBe(before.projects + 1);
      expect(await prisma.repository.count()).toBe(before.repositories + 1);
      expect(await prisma.worktree.count()).toBe(before.worktrees + 1);

      const retry = output<{ id: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: argumentsValue,
        }),
      );
      expect(retry.id).toBe(created.id);
    } finally {
      await transport.close();
    }
  }, 15_000);

  it("rejects a non-Git repositoryPath without leaving partial scope records", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "actionables-scope-"));
    const before = {
      projects: await prisma.project.count(),
      repositories: await prisma.repository.count(),
      worktrees: await prisma.worktree.count(),
      actionables: await prisma.actionable.count(),
    };
    const { client, transport } = await connectClient();
    try {
      const error = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            repositoryPath: directory,
            ensureScope: true,
            title: "Task with invalid automatic scope",
          },
        }),
      );
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        errors: { repositoryPath: expect.any(Array) },
      });
      expect(await prisma.project.count()).toBe(before.projects);
      expect(await prisma.repository.count()).toBe(before.repositories);
      expect(await prisma.worktree.count()).toBe(before.worktrees);
      expect(await prisma.actionable.count()).toBe(before.actionables);
    } finally {
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed placement, unknown or nested parents, and conflicting retries", async () => {
    const root = await createTask({ title: "Creation boundary root" });
    const { client, transport } = await connectClient();
    try {
      for (const argumentsValue of [
        {
          idempotencyKey: randomUUID(),
          title: "Missing top-level scope",
        },
        {
          idempotencyKey: "not-a-uuid",
          ...scope,
          title: "Malformed idempotency key",
        },
        {
          idempotencyKey: randomUUID(),
          parentId: root.sourceOrdinal,
          ...scope,
          title: "Parent plus forbidden explicit scope",
        },
        {
          idempotencyKey: randomUUID(),
          repositoryPath: repoRoot,
          title: "Repository path without provisioning permission",
        },
        {
          idempotencyKey: randomUUID(),
          ensureScope: true,
          title: "Provisioning permission without a repository path",
        },
        {
          idempotencyKey: randomUUID(),
          ...scope,
          repositoryPath: repoRoot,
          ensureScope: true,
          title: "Existing and automatic scope together",
        },
        {
          idempotencyKey: randomUUID(),
          parentId: 0,
          title: "Invalid parent ID",
        },
        {
          idempotencyKey: randomUUID(),
          ...scope,
          title: " ",
        },
      ]) {
        expect(
          (
            await client.callTool({
              name: "actionables.create_task",
              arguments: argumentsValue,
            })
          ).isError,
        ).toBe(true);
      }

      const unknownParent = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            parentId: 999_999,
            title: "Unknown parent",
          },
        }),
      );
      expect(unknownParent).toMatchObject({
        code: "NOT_FOUND",
        errors: { parentId: expect.any(Array) },
      });

      const invalidScope = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            projectId: "missing-project",
            repositoryId: "missing-repository",
            worktreeId: "missing-worktree",
            title: "Invalid top-level scope",
          },
        }),
      );
      expect(invalidScope).toMatchObject({
        code: "INVALID_SCOPE",
        errors: {
          projectId: expect.any(Array),
          repositoryId: expect.any(Array),
          worktreeId: expect.any(Array),
        },
      });

      const child = output<{ id: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            parentId: root.sourceOrdinal,
            title: "Existing direct child",
          },
        }),
      );
      const nested = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            parentId: child.id,
            title: "Forbidden grandchild",
          },
        }),
      );
      expect(nested).toMatchObject({
        code: "HIERARCHY_DEPTH_EXCEEDED",
        errors: { parent: expect.any(Array) },
      });

      const reusedKey = randomUUID();
      const originalArguments = {
        idempotencyKey: reusedKey,
        ...scope,
        title: "Original keyed task",
      };
      const original = output<{ id: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: originalArguments,
        }),
      );
      const conflict = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            ...originalArguments,
            title: "Different task with reused key",
          },
        }),
      );
      expect(conflict).toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        retryable: false,
      });
      expect(
        await prisma.actionable.count({
          where: {
            sourceOrdinal: original.id,
            title: originalArguments.title,
          },
        }),
      ).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it("runs list, claim-with-detail, update, transition, validation, and release", async () => {
    const task = await createTask({ title: "End-to-end MCP workflow" });
    const { client, transport } = await connectClient();
    try {
      const listed = output<{ items: Array<{ id: number; version: number }> }>(
        await client.callTool({
          name: "actionables.list_tasks",
          arguments: {
            view: "available",
            workItemId: task.sourceOrdinal,
            limit: 100,
          },
        }),
      );
      const available = listed.items.find(
        (item) => item.id === task.sourceOrdinal,
      );
      expect(available).toBeDefined();

      const claimed = output<{
        task: { title: string; version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: available!.version,
            leaseMinutes: 30,
          },
        }),
      );
      expect(claimed.task.title).toBe("End-to-end MCP workflow");
      expect(
        (
          await prisma.agentTaskClaim.findUniqueOrThrow({
            where: { actionableId: task.id },
          })
        ).agentId,
      ).toBe(agentId);
      const credentials = {
        id: task.sourceOrdinal,
        claimToken: claimed.claim.claimToken,
      };

      const renewed = output<{ task: { version: number } }>(
        await client.callTool({
          name: "actionables.renew_task_claim",
          arguments: { ...credentials, leaseMinutes: 60 },
        }),
      );
      expect(renewed.task.version).toBe(claimed.task.version);

      const inProgress = output<{ status: string; version: number }>(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: claimed.task.version,
            status: "In progress",
          },
        }),
      );
      expect(inProgress.status).toBe("In progress");

      const updated = output<{
        finding: string;
        research: string[];
        version: number;
      }>(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            ...credentials,
            version: inProgress.version,
            finding: "The official MCP client completed a real request.",
          },
        }),
      );
      expect(updated.finding).toContain("official MCP client");

      const validated = output<{
        validationRecords: Array<{
          outcome: string;
          qualifiesForCompletion: boolean;
        }>;
        version: number;
      }>(
        await client.callTool({
          name: "actionables.record_task_validation",
          arguments: {
            ...credentials,
            version: updated.version,
            type: "Command",
            outcome: "Passed",
            notes: "Focused MCP workflow passed.",
            evidence:
              "Official SDK client calls returned valid structured results.",
          },
        }),
      );
      expect(validated.validationRecords.at(-1)).toMatchObject({
        outcome: "Passed",
        qualifiesForCompletion: true,
      });

      const released = output<{ task: { claim: null; version: number } }>(
        await client.callTool({
          name: "actionables.release_task",
          arguments: credentials,
        }),
      );
      expect(released.task).toMatchObject({
        claim: null,
        version: validated.version + 1,
      });
    } finally {
      await transport.close();
    }
  });

  it("returns lean authoritative research receipts with conditional lifecycle guidance", async () => {
    const researchingTask = await createTask({
      status: "Researching",
      title: "Research receipt",
    });
    await prisma.actionable.update({
      where: { id: researchingTask.id },
      data: { researchJson: json(["Existing note"]) },
    });
    const readyTask = await createTask({
      status: "Ready",
      title: "Ready research receipt",
    });
    const { client, transport } = await connectClient();
    try {
      const researchingClaim = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: researchingTask.sourceOrdinal,
            workItemId: researchingTask.sourceOrdinal,
            version: researchingTask.version,
          },
        }),
      );
      const credentials = {
        id: researchingTask.sourceOrdinal,
        claimToken: researchingClaim.claim.claimToken,
      };

      const mixed = output<{
        id: number;
        version: number;
        status: string;
        appended: number;
        duplicatesIgnored: number;
        lifecycleGuidance?: string;
      }>(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            ...credentials,
            version: researchingClaim.task.version,
            appendResearch: [
              "Existing note",
              "New note",
              "New note",
              "Another note",
            ],
          },
        }),
      );
      expect(mixed).toEqual({
        id: researchingTask.sourceOrdinal,
        version: researchingClaim.task.version + 1,
        status: "Researching",
        appended: 2,
        duplicatesIgnored: 2,
        lifecycleGuidance: expect.any(String),
      });
      expect(mixed.lifecycleGuidance).toContain("Keep this task Researching");
      expect(mixed.lifecycleGuidance).toContain("remaining questions");
      expect(mixed.lifecycleGuidance).toContain("next research step");
      expect(mixed.lifecycleGuidance).toContain(
        "otherwise transition it to Ready",
      );
      expect(mixed.lifecycleGuidance).toContain(
        "Do not force a transition solely because a turn ended",
      );
      expect(
        (
          await prisma.actionable.findUniqueOrThrow({
            where: { id: researchingTask.id },
          })
        ).researchJson,
      ).toEqual(["Existing note", "New note", "Another note"]);

      const duplicatesOnly = output<Record<string, unknown>>(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            ...credentials,
            version: mixed.version,
            appendResearch: ["Existing note", "New note"],
          },
        }),
      );
      expect(duplicatesOnly).toEqual({
        id: researchingTask.sourceOrdinal,
        version: mixed.version + 1,
        status: "Researching",
        appended: 0,
        duplicatesIgnored: 2,
      });

      const readyClaim = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: readyTask.sourceOrdinal,
            workItemId: readyTask.sourceOrdinal,
            version: readyTask.version,
          },
        }),
      );
      const readyReceipt = output<Record<string, unknown>>(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            id: readyTask.sourceOrdinal,
            claimToken: readyClaim.claim.claimToken,
            version: readyClaim.task.version,
            appendResearch: ["Ready-state note"],
          },
        }),
      );
      expect(readyReceipt).toEqual({
        id: readyTask.sourceOrdinal,
        version: readyClaim.task.version + 1,
        status: "Ready",
        appended: 1,
        duplicatesIgnored: 0,
      });
    } finally {
      await transport.close();
    }
  });

  it("keeps oversized task detail below the context budget and reports omissions", async () => {
    const task = await createTask({
      title: `Bounded detail ${"x".repeat(180)}`,
    });
    const related = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        createTask({
          title: `Related ${index} ${"r".repeat(180)}`,
        }),
      ),
    );
    await prisma.actionable.update({
      where: { id: task.id },
      data: {
        finding: "f".repeat(100_000),
        description: "d".repeat(100_000),
        researchJson: json(Array.from({ length: 12 }, () => "r".repeat(1_000))),
        validationJson: json(
          Array.from({ length: 12 }, () => "p".repeat(1_000)),
        ),
        tagsJson: json(
          Array.from({ length: 20 }, (_, index) => `tag-${index}`),
        ),
        filesJson: json(
          Array.from({ length: 12 }, () => ({
            path: "a".repeat(2_000),
            lines: "1".repeat(500),
          })),
        ),
      },
    });
    await prisma.userSourceReference.createMany({
      data: Array.from({ length: 10 }, (_, index) => ({
        actionableId: task.id,
        type: "URL",
        locator: `https://example.test/${index}/${"s".repeat(1_000)}`,
        label: "l".repeat(200),
      })),
    });
    await prisma.validationRecord.createMany({
      data: Array.from({ length: 10 }, () => ({
        actionableId: task.id,
        type: "Command",
        outcome: "Passed",
        notesMd: "n".repeat(2_000),
        evidenceMd: "e".repeat(2_000),
        origin: "o".repeat(200),
      })),
    });
    for (const [index, item] of related.entries()) {
      if (index < 8) {
        await prisma.hierarchyRelationship.create({
          data: {
            parentId: task.id,
            childId: item.id,
            provenance: "test",
          },
        });
        await prisma.dependencyRelationship.create({
          data: {
            dependentId: task.id,
            prerequisiteId: item.id,
            provenance: "test",
          },
        });
      } else {
        await prisma.dependencyRelationship.create({
          data: {
            dependentId: item.id,
            prerequisiteId: task.id,
            provenance: "test",
          },
        });
      }
    }

    const { client, transport } = await connectClient();
    try {
      const claimed = output<{
        task: {
          truncation: {
            truncatedFields: string[];
            omitted: Record<string, number>;
          };
        };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: task.version,
            leaseMinutes: 30,
          },
        }),
      );
      const detail = claimed.task;

      expect(JSON.stringify(detail).length).toBeLessThan(30_000);
      expect(detail.truncation.truncatedFields).toEqual(
        expect.arrayContaining([
          "finding",
          "description",
          "research",
          "plannedValidation",
          "files",
          "userSources",
          "validationRecords",
          "subtasks",
          "blockedBy",
          "blocks",
        ]),
      );
      expect(detail.truncation.omitted).toEqual({
        research: 6,
        plannedValidation: 6,
        tags: 10,
        files: 6,
        userSources: 5,
        validationRecords: 5,
        subtasks: 3,
        blockedBy: 3,
        blocks: 3,
      });
    } finally {
      await transport.close();
    }
  });

  it("returns self-correcting errors for invalid, stale, wrong, and expired claims", async () => {
    const task = await createTask({ title: "MCP error task" });
    const { client, transport } = await connectClient();
    try {
      const invalid = await client.callTool({
        name: "actionables.list_tasks",
        arguments: {
          view: "available",
          workItemId: task.sourceOrdinal,
          limit: 101,
        },
      });
      expect(invalid.isError).toBe(true);

      const claimed = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: task.version,
            leaseMinutes: 30,
          },
        }),
      );
      const wrongToken = errorOutput(
        await client.callTool({
          name: "actionables.get_task",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: "x".repeat(43),
          },
        }),
      );
      expect(wrongToken.code).toBe("INVALID_CLAIM_TOKEN");
      expect(wrongToken).toMatchObject({
        retryable: false,
        nextAction: expect.stringContaining("Discard the token"),
      });

      const stale = errorOutput(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
            version: task.version,
            title: "Must not save",
          },
        }),
      );
      expect(stale).toMatchObject({
        code: "VERSION_CONFLICT",
        currentVersion: claimed.task.version,
        retryable: true,
        nextAction: expect.stringContaining("current version"),
      });

      await prisma.agentTaskClaim.update({
        where: { actionableId: task.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      const expired = errorOutput(
        await client.callTool({
          name: "actionables.get_task",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
          },
        }),
      );
      expect(expired).toMatchObject({
        code: "CLAIM_EXPIRED",
        retryable: true,
        nextAction: expect.stringContaining("same work item"),
      });
    } finally {
      await transport.close();
    }
  });

  it("rejects unauthenticated and non-loopback requests and disables GET/DELETE", async () => {
    const endpoint = `${address}/mcp`;
    const initialization = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "security-test", version: "1.0.0" },
      },
    };
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(initialization),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { ...headers, authorization: "Bearer wrong" },
          body: JSON.stringify(initialization),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            ...headers,
            host: "attacker.example",
            authorization: `Bearer ${bearerToken}`,
          },
          payload: initialization,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            ...headers,
            authorization: `Bearer ${bearerToken}`,
            origin: "https://attacker.example",
          },
          body: JSON.stringify(initialization),
        })
      ).status,
    ).toBe(403);

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(endpoint, {
        method,
        headers: { authorization: `Bearer ${bearerToken}` },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }

    const disabled = buildApp({ prisma });
    expect(
      (await disabled.inject({ method: "POST", url: "/mcp" })).statusCode,
    ).toBe(404);
    await disabled.close();
  });
});
