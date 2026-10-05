import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  actionableReviewPageSchema,
  reviewResourceUri,
  type ActionableReviewPage,
} from "@actionables/contracts/chatgpt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildChatgptApp, readReviewHtml } from "../src/chatgpt-mcp.js";
import { startChatgptServer } from "../src/chatgpt-server.js";
import { createPrismaClient, type AppPrismaClient } from "../src/database.js";
import { getActionable } from "../src/repository.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const token = randomUUID() + randomUUID();
const json = (value: unknown) => value as never;
let directory: string;
let databasePath: string;
let writer: AppPrismaClient;
let reader: AppPrismaClient;
let app: ReturnType<typeof buildChatgptApp>;
let address: string;
let html: string;
let browser: Browser;
let client: Client;
let transport: StreamableHTTPClientTransport;

/** Every persisted table, including claim/settings/audit/idempotency/migration state. */
function snapshot() {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => {
        const rows = database
          .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
          .all();
        return [name, rows.map((row) => JSON.stringify(row)).sort()];
      }),
    );
  } finally {
    database.close();
  }
}

function output(value: unknown) {
  const result = value as CallToolResult;
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
    true,
  );
  return actionableReviewPageSchema.parse(result.structuredContent);
}
function failure(value: unknown, code?: string) {
  const result = value as CallToolResult;
  expect(result.isError).toBe(true);
  if (code)
    expect(
      result.structuredContent ??
        JSON.parse(
          result.content.find((item) => item.type === "text")?.text ?? "{}",
        ),
    ).toMatchObject({ code });
  return result;
}
const get = (args: Record<string, unknown>) =>
  client.callTool({ name: "actionables.get_actionable", arguments: args });

beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), "actionables-chatgpt-proof-"));
  databasePath = resolve(directory, "synthetic.db");
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  await writeFile(databasePath, "");
  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "node_modules/prisma/build/index.js"),
      "migrate",
      "deploy",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    },
  );
  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "node_modules/vite/bin/vite.js"),
      "build",
      "--config",
      "vite.chatgpt.config.ts",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        NODE_ENV: "production",
        CHATGPT_UI_OUT_DIR: resolve(directory, "ui"),
      },
      stdio: "pipe",
    },
  );
  html = await readReviewHtml(resolve(directory, "ui/review.html"));
  writer = createPrismaClient(databaseUrl);
  reader = createPrismaClient(databaseUrl, true);
  const project = await writer.project.create({
    data: { externalKey: "chatgpt-synthetic", name: "Synthetic project" },
  });
  const repository = await writer.repository.create({
    data: {
      externalKey: "chatgpt-synthetic",
      name: "Synthetic repository",
      projectId: project.id,
      localPath: "C:/private/source",
    },
  });
  const worktree = await writer.worktree.create({
    data: {
      externalKey: "chatgpt-synthetic",
      name: "Synthetic worktree",
      projectId: project.id,
      repositoryId: repository.id,
      localPath: "C:/private/worktree",
    },
  });
  const scope = {
    projectId: project.id,
    repositoryId: repository.id,
    worktreeId: worktree.id,
  };
  async function task(
    id: number,
    status = "Ready",
    extra: Record<string, unknown> = {},
  ) {
    return writer.actionable.create({
      data: {
        sourceOrdinal: id,
        externalKey: `synthetic-${id}`,
        title: `Synthetic task ${id}`,
        status,
        priority: "High",
        effort: "S",
        evidenceState: "Confirmed",
        statusProvenance: "Synthetic test only",
        updatedLabel: "fixture",
        finding: "Authoritative synthetic finding",
        description: "Synthetic review description",
        resolution: "Synthetic resolution",
        researchJson: json(["Synthetic research observation"]),
        validationJson: json(["Check synthetic fixture"]),
        filesJson: json([{ path: "C:/private/evidence.txt" }]),
        tagsJson: json(["synthetic"]),
        userSourcesJson: json([]),
        blockedByOrdinalsJson: json([]),
        blocksOrdinalsJson: json([]),
        childOrdinalsJson: json([]),
        importProvider: "CODEX",
        sourceContainerId: "private-container",
        sourceThread: "private-thread",
        contentHash: "",
        rawFragmentJson: json({ secret: "raw-import-must-not-leak" }),
        ...scope,
        ...extra,
      },
    });
  }
  const root = await task(1000);
  const selected = await task(1001, "In progress", {
    title: "Synthetic review target",
    manualBlockerMd: "Awaiting synthetic review",
    description:
      "**Review finding**\n\n<script>window.pwned=true</script>\n\n![tracking](https://tracker.invalid/image.png)\n\n[local](http://127.0.0.1:4174/api) [unsafe](javascript:alert(1)) [external](https://example.com)",
  });
  const child = await task(1002, "Done");
  const unresolved = await task(1003);
  const waived = await task(1004);
  const dismissed = await task(1005, "Dismissed");
  const satisfied = await task(1006, "Done");
  const dependent = await task(1007);
  await task(1008, "Done", { archivedAt: new Date("2026-10-01T00:00:00Z") });
  const large = await task(1009, "Ready", {
    description: "Large synthetic context 🧪\r\n".repeat(600),
    researchJson: json(
      Array.from(
        { length: 55 },
        (_, i) => `Research ${i}: ` + "Evidence 🧪\r\n".repeat(120),
      ),
    ),
  });
  await writer.validationRecord.create({
    data: {
      actionableId: large.id,
      type: "Automated test",
      outcome: "Passed",
      notesMd: "Large validation notes 🧪\r\n".repeat(600),
      evidenceMd:
        "Large validation evidence 🧪\r\n".repeat(600) +
        "End of long validation evidence",
      origin: "Synthetic fixture",
      recordedAt: new Date("2026-10-03T00:00:00Z"),
    },
  });
  const archivedRoot = await task(1010, "Ready", {
    archivedAt: new Date("2026-10-01T00:00:00Z"),
  });
  const archivedRootChild = await task(1011);
  for (const [parent, descendant] of [
    [root, selected],
    [selected, child],
    [archivedRoot, archivedRootChild],
  ])
    await writer.hierarchyRelationship.create({
      data: { parentId: parent.id, childId: descendant.id },
    });
  for (const [prerequisite, waiver] of [
    [unresolved, false],
    [waived, true],
    [dismissed, false],
    [satisfied, false],
  ] as const)
    await writer.dependencyRelationship.create({
      data: {
        dependentId: selected.id,
        prerequisiteId: prerequisite.id,
        ...(waiver
          ? {
              waivedAt: new Date("2026-10-01T00:00:00Z"),
              waiverReason: "Synthetic waiver",
            }
          : {}),
      },
    });
  await writer.dependencyRelationship.create({
    data: { dependentId: dependent.id, prerequisiteId: selected.id },
  });
  await writer.actionableStatusHistory.create({
    data: {
      actionableId: selected.id,
      previousStatus: "Ready",
      newStatus: "In progress",
      origin: "Synthetic fixture",
      occurredAt: new Date("2026-10-01T00:00:00Z"),
    },
  });
  const old = await writer.validationRecord.create({
    data: {
      actionableId: selected.id,
      type: "Automated test",
      outcome: "Passed",
      notesMd: "Original synthetic validation",
      evidenceMd: "Synthetic original evidence",
      origin: "Synthetic fixture",
      recordedAt: new Date("2026-10-02T00:00:00Z"),
    },
  });
  await writer.validationRecord.create({
    data: {
      actionableId: selected.id,
      type: "Review",
      outcome: "Passed",
      notesMd: "Corrected synthetic validation",
      evidenceMd: "Synthetic corrected evidence",
      origin: "Synthetic fixture",
      supersedesId: old.id,
      recordedAt: new Date("2026-10-03T00:00:00Z"),
    },
  });
  await writer.activityEvent.create({
    data: {
      actionableId: selected.id,
      type: "agent-updated",
      summary: "Synthetic research saved",
      metadataJson: json({
        path: "C:/private/activity.txt",
        claimToken: "must-not-leak",
      }),
    },
  });
  await writer.userSourceReference.create({
    data: {
      actionableId: selected.id,
      type: "File",
      locator: "C:/private/source.txt",
    },
  });
  for (const [taskRow, expired] of [
    [selected, true],
    [child, false],
  ] as const)
    await writer.agentTaskClaim.create({
      data: {
        actionableId: taskRow.id,
        agentId: "synthetic-owner",
        claimTokenHash: `synthetic-hash-${taskRow.sourceOrdinal}`,
        leaseExpiresAt: new Date(
          expired ? "2020-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
        ),
      },
    });
  app = buildChatgptApp({
    prisma: reader,
    bearerToken: token,
    reviewHtml: html,
  });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
  client = new Client({ name: "synthetic-chatgpt-proof", version: "1.0.0" });
  transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  await writeFile(
    resolve(directory, "proof.json"),
    JSON.stringify(
      {
        databaseUrl,
        reviewHtml: resolve(directory, "ui/review.html"),
        reviewId: 1001,
        largeContextId: 1009,
        archivedId: 1008,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `Synthetic ChatGPT proof fixture: ${resolve(directory, "proof.json")}\n`,
  );
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await transport?.close();
  await app?.close();
  await reader?.$disconnect();
  await writer?.$disconnect();
  // Disposable isolated files stay in Windows TEMP; only owned resources are closed.
});

describe("read-only ChatGPT MCP proof", () => {
  it("enforces exactly two tools, current UI metadata and server-side write rejection", async () => {
    const before = snapshot();
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "actionables.get_actionable",
      "actionables.render_actionable_review",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toEqual(
        expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: true,
        }),
      );
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema).toBeDefined();
    }
    expect(tools[0]._meta).not.toHaveProperty("ui.resourceUri");
    expect(tools[1]._meta).toMatchObject({
      ui: { resourceUri: reviewResourceUri },
    });
    const resources = await client.listResources();
    expect(resources.resources).toEqual([
      expect.objectContaining({
        uri: reviewResourceUri,
        mimeType: "text/html;profile=mcp-app",
        _meta: {
          ui: expect.objectContaining({
            csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
          }),
        },
      }),
    ]);
    const resource = await client.readResource({ uri: reviewResourceUri });
    expect(resource.contents[0]).toMatchObject({
      text: html,
      mimeType: "text/html;profile=mcp-app",
    });
    for (const name of [
      "actionables.create_task",
      "actionables.claim_task",
      "actionables.update_task",
      "actionables.transition_task",
      "actionables.record_task_validation",
    ])
      failure(await client.callTool({ name, arguments: { id: 1001 } }));
    expect(snapshot()).toEqual(before);
    expect(await writer.helperAgentSettings.count()).toBe(0);
  });

  it("returns backend review values without claim/thread metadata and changes no persisted state", async () => {
    const before = snapshot();
    const detail = (await getActionable(reader, 1001))!;
    const page = output(await get({ id: 1001 }));
    expect(page.complete).toBe(true);
    expect(page.summary).toMatchObject({
      id: detail.id,
      workItemId: detail.workItemId,
      status: detail.status,
      priority: detail.priority,
      version: detail.version,
      archiveState: detail.archiveState,
      directTaskProgress: detail.directTaskProgress,
      readiness: detail.readiness,
      hasQualifyingValidation: detail.hasQualifyingValidation,
      completionEligibility: detail.completionEligibility,
      isDependencyBlocked: detail.isDependencyBlocked,
      isEffectivelyBlocked: detail.isEffectivelyBlocked,
      unresolvedDependencyCount: detail.unresolvedDependencyCount,
    });
    const values = (field: string) =>
      page.items
        .filter((item) => item.field === field && item.kind === "value")
        .map((item) => (item as { value: unknown }).value);
    expect(values("finding")).toEqual([detail.finding]);
    expect(values("description")).toEqual([detail.description]);
    expect(values("manualBlocker")).toEqual([detail.manualBlocker]);
    expect(values("research")).toEqual(detail.research);
    expect(values("plannedValidation")).toEqual(detail.validation);
    expect(values("validationRecords")).toEqual(detail.validationRecords);
    expect(values("parent")).toEqual([
      expect.objectContaining({
        id: 1000,
        title: detail.relationships.parent!.parent.title,
      }),
    ]);
    expect(values("subtasks")).toEqual(
      detail.relationships.subtasks.map(({ child }) =>
        expect.objectContaining({
          id: child.id,
          title: child.title,
          status: child.status,
          version: child.version,
          archiveState: child.archiveState,
        }),
      ),
    );
    for (const field of ["blockedBy", "blocks"] as const)
      expect(values(field)).toEqual(
        detail.relationships[field].map((dependency) =>
          expect.objectContaining({
            id: dependency[field === "blockedBy" ? "prerequisite" : "dependent"]
              .id,
            state: dependency.state,
            isSatisfied: dependency.isSatisfied,
            waiverReason: dependency.waiverReason,
          }),
        ),
      );
    expect(values("blockedBy")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "dismissed-prerequisite",
          isSatisfied: false,
        }),
        expect.objectContaining({ state: "waived", isSatisfied: true }),
      ]),
    );
    const serialized = JSON.stringify(page);
    for (const secret of [
      "private-thread",
      "C:/private/",
      "raw-import-must-not-leak",
      "synthetic-owner",
      "claimToken",
      "claimTokenHash",
      "sourceContainerId",
      "recordId",
    ])
      expect(serialized).not.toContain(secret);
    const rendered = output(
      await client.callTool({
        name: "actionables.render_actionable_review",
        arguments: {
          id: 1001,
          version: page.summary.version,
          contentHash: page.contentHash,
        },
      }),
    );
    expect(rendered).toEqual(page);
    expect(snapshot()).toEqual(before);
  });

  it("rejects invalid/missing IDs and stale versions; archives require explicit inclusion", async () => {
    const before = snapshot();
    for (const id of [0, -1, 1.2, "1001", Number.MAX_SAFE_INTEGER + 1])
      failure(await get({ id }));
    failure(await get({ id: 999999 }), "NOT_FOUND");
    failure(await get({ id: 1001, claimToken: "not-accepted" }));
    failure(await get({ id: 1001, offset: 1 }));
    failure(await get({ id: 1001, version: 9999 }), "VERSION_CONFLICT");
    failure(
      await client.callTool({
        name: "actionables.render_actionable_review",
        arguments: { id: 1001, version: 9999 },
      }),
      "VERSION_CONFLICT",
    );
    failure(
      await client.callTool({
        name: "actionables.render_actionable_review",
        arguments: {
          id: 1001,
          version: 1,
          title: "Model-authored replacement",
        },
      }),
    );
    for (const id of [1008, 1011]) {
      failure(await get({ id }), "ARCHIVE_INCLUSION_REQUIRED");
      expect(output(await get({ id, includeArchived: true })).summary.id).toBe(
        id,
      );
    }
    expect(snapshot()).toEqual(before);
  });

  it("pages large native context exactly and refuses hash or offset drift", async () => {
    const before = snapshot();
    const first = output(await get({ id: 1009 }));
    expect(first.complete).toBe(false);
    const all = [...first.items];
    let page = first;
    while (page.nextOffset !== null) {
      expect(JSON.stringify(page.items).length).toBeLessThanOrEqual(8000);
      expect(page.items.length).toBeLessThanOrEqual(40);
      page = output(
        await get({
          id: 1009,
          version: first.summary.version,
          contentHash: first.contentHash,
          offset: page.nextOffset,
        }),
      );
      all.push(...page.items);
    }
    const detail = (await getActionable(reader, 1009))!;
    const record = structuredClone(
      all.find(
        (item) => item.field === "validationRecords" && item.kind === "value",
      )!,
    ) as { value: Record<string, unknown> };
    for (const item of all) {
      if (
        item.field === "validationRecords" &&
        item.kind === "text" &&
        item.property
      ) {
        expect(String(record.value[item.property]).length).toBe(item.offset);
        record.value[item.property] =
          String(record.value[item.property]) + item.text;
      }
    }
    expect(record.value).toEqual(detail.validationRecords[0]);
    const text = (field: string, index: number) =>
      all
        .filter((item) => item.field === field && item.index === index)
        .map((item) => (item.kind === "text" ? item.text : item.value))
        .join("");
    expect(text("description", 0)).toBe(detail.description);
    for (let index = 0; index < detail.research.length; index++)
      expect(text("research", index)).toBe(detail.research[index]);
    failure(
      await get({
        id: 1009,
        version: first.summary.version,
        contentHash: "0".repeat(64),
        offset: first.nextOffset,
      }),
      "VERSION_CONFLICT",
    );
    failure(
      await get({
        id: 1009,
        version: first.summary.version,
        contentHash: first.contentHash,
        offset: first.totalItems + 1,
      }),
      "INVALID_REQUEST",
    );
    expect(snapshot()).toEqual(before);
  });

  it("detects independently changed relationship context even at the same selected version", async () => {
    const first = output(await get({ id: 1001 }));
    await writer.actionable.update({
      where: { sourceOrdinal: 1003 },
      data: { title: "Changed synthetic prerequisite" },
    });
    const before = snapshot();
    failure(
      await get({
        id: 1001,
        version: first.summary.version,
        contentHash: first.contentHash,
      }),
      "VERSION_CONFLICT",
    );
    failure(
      await client.callTool({
        name: "actionables.render_actionable_review",
        arguments: {
          id: 1001,
          version: first.summary.version,
          contentHash: first.contentHash,
        },
      }),
      "VERSION_CONFLICT",
    );
    expect(output(await get({ id: 1001 })).summary.version).toBe(
      first.summary.version,
    );
    expect(snapshot()).toEqual(before);
  });

  it("retains bearer, Host/Origin, method and loopback protections", async () => {
    const before = snapshot();
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "synthetic", version: "1" },
      },
    };
    for (const headers of [{}, { authorization: "Bearer wrong" }])
      expect(
        (await app.inject({ method: "POST", url: "/mcp", headers, payload }))
          .statusCode,
      ).toBe(401);
    for (const headers of [
      { host: "public.example" },
      { origin: "https://chatgpt.com" },
      { origin: "http://127.0.0.1/path" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/mcp",
            headers: {
              host: "127.0.0.1",
              authorization: `Bearer ${token}`,
              ...headers,
            },
            payload,
          })
        ).statusCode,
      ).toBe(403);
    for (const method of ["GET", "DELETE"] as const)
      expect(
        (
          await app.inject({
            method,
            url: "/mcp",
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(405);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/actionables",
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    await expect(
      reader.actionable.update({
        where: { sourceOrdinal: 1001 },
        data: { title: "Cannot write through read-only connection" },
      }),
    ).rejects.toThrow();
    await expect(startChatgptServer({})).rejects.toThrow("explicit absolute");
    await expect(
      startChatgptServer({ DATABASE_URL: "file:./data/actionables.db" }),
    ).rejects.toThrow("explicit absolute");
    await expect(
      startChatgptServer({
        DATABASE_URL: `file:${resolve(directory, "absent.db")}`,
      }),
    ).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });
});

async function widget(page: Page, result: unknown) {
  await page.exposeFunction("hostRead", async (args: Record<string, unknown>) =>
    get(args),
  );
  await page.setContent(
    '<iframe title="Review" sandbox="allow-scripts allow-same-origin"></iframe>',
  );
  await page.evaluate(
    ({ html, result }) => {
      const iframe = document.querySelector("iframe")!;
      const observed: string[] = [];
      Object.assign(window, { observed });
      window.addEventListener("message", async (event) => {
        if (event.source !== iframe.contentWindow) return;
        const message = event.data;
        observed.push(message.method ?? "response");
        const respond = (value: unknown) =>
          iframe.contentWindow!.postMessage(
            { jsonrpc: "2.0", id: message.id, result: value },
            "*",
          );
        if (message.method === "ui/initialize")
          respond({
            protocolVersion: message.params.protocolVersion,
            hostInfo: { name: "Synthetic test host", version: "1" },
            hostCapabilities: { serverTools: {} },
            hostContext: { theme: "light", displayMode: "inline" },
          });
        else if (message.method === "ui/notifications/initialized") {
          iframe.contentWindow!.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-input",
              params: { arguments: { id: 1001, version: 1 } },
            },
            "*",
          );
          iframe.contentWindow!.postMessage(
            {
              jsonrpc: "2.0",
              method: "ui/notifications/tool-result",
              params: result,
            },
            "*",
          );
        } else if (message.method === "tools/call")
          respond(
            await (
              window as unknown as {
                hostRead: (args: unknown) => Promise<unknown>;
              }
            ).hostRead(message.params.arguments),
          );
        else if (message.id !== undefined) respond({});
      });
      iframe.srcdoc = html;
    },
    { html, result },
  );
  return page.frameLocator('iframe[title="Review"]');
}

describe("actual built MCP Apps resource", () => {
  it("initializes, receives backend results and presents authoritative review with inert hostile Markdown", async () => {
    const before = snapshot();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const result = await client.callTool({
      name: "actionables.render_actionable_review",
      arguments: {
        id: 1001,
        version: (await getActionable(reader, 1001))!.version,
      },
    });
    const frame = await widget(page, result);
    await frame
      .getByRole("heading", { name: "Synthetic review target" })
      .waitFor();
    expect(
      await page.evaluate(
        () => (window as unknown as { observed: string[] }).observed,
      ),
    ).toEqual(
      expect.arrayContaining(["ui/initialize", "ui/notifications/initialized"]),
    );
    await frame.getByText("dismissed-prerequisite", { exact: true }).waitFor();
    expect(await frame.getByText("Superseded", { exact: true }).count()).toBe(
      1,
    );
    expect(
      await frame
        .getByText("Qualifies for completion", { exact: true })
        .count(),
    ).toBe(1);
    expect(await frame.locator("img, a[href], form").count()).toBe(0);
    expect(
      await page
        .frames()[1]
        .evaluate(() => (window as unknown as { pwned?: boolean }).pwned),
    ).toBeUndefined();
    await frame.getByRole("button", { name: "Reload review" }).click();
    await frame
      .getByRole("heading", { name: "Synthetic review target" })
      .waitFor();
    expect(requests).toEqual([]);
    expect(snapshot()).toEqual(before);
    await page.close();
  }, 30_000);

  it("loads partial pages over the bridge and discards stale data before reloading", async () => {
    const before = snapshot();
    const page = await browser.newPage();
    const first = await get({ id: 1009 });
    const frame = await widget(page, first);
    await frame
      .getByRole("button", { name: "Load remaining context" })
      .waitFor();
    expect(await frame.getByRole("status").textContent()).toContain(
      "Partial context",
    );
    while (
      await frame
        .getByRole("button", { name: "Load remaining context" })
        .count()
    ) {
      const status = await frame.getByRole("status").textContent();
      await frame
        .getByRole("button", { name: "Load remaining context" })
        .click();
      await page.waitForFunction(
        (previous) =>
          document
            .querySelector("iframe")!
            .contentDocument!.querySelector('[role="status"]')?.textContent !==
          previous,
        status,
      );
    }
    await frame
      .getByText("End of long validation evidence", { exact: false })
      .waitFor({ state: "attached" });
    expect(
      await page.evaluate(
        () => (window as unknown as { observed: string[] }).observed,
      ),
    ).toContain("tools/call");
    await page.evaluate(() =>
      document.querySelector("iframe")!.contentWindow!.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            isError: true,
            content: [{ type: "text", text: "stale" }],
            structuredContent: { code: "VERSION_CONFLICT" },
          },
        },
        "*",
      ),
    );
    await frame.getByRole("alert").waitFor();
    expect(await frame.getByRole("alert").textContent()).toContain(
      "review changed",
    );
    expect(await frame.getByRole("heading").count()).toBe(0);
    await frame.getByRole("button", { name: "Reload review" }).click();
    await frame.getByRole("heading", { name: "Synthetic task 1009" }).waitFor();
    await page.evaluate(() =>
      document.querySelector("iframe")!.contentWindow!.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            isError: true,
            content: [],
            structuredContent: { code: "NOT_FOUND" },
          },
        },
        "*",
      ),
    );
    await frame.getByText("The requested Actionable was not found.").waitFor();
    expect(snapshot()).toEqual(before);
    await page.close();
  }, 30_000);
});
