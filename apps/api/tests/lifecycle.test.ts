import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Status } from "@actionables/contracts";
import { buildApp } from "../src/app.js";
import { createPrismaClient, type AppPrismaClient } from "../src/database.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const prismaCli = resolve(repoRoot, "node_modules/prisma/build/index.js");

let databasePath: string;
let prisma: AppPrismaClient | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let scope: { projectId: string; repositoryId: string; worktreeId: string };

beforeAll(async () => {
  const databaseName = `lifecycle-${randomUUID()}.db`;
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
    data: {
      externalKey: "lifecycle-project",
      name: "Lifecycle project",
      repositories: {
        create: {
          externalKey: "lifecycle-repository",
          name: "Lifecycle repository",
        },
      },
    },
    include: { repositories: true },
  });
  const worktree = await prisma.worktree.create({
    data: {
      externalKey: "lifecycle-worktree",
      name: "Lifecycle worktree",
      projectId: project.id,
      repositoryId: project.repositories[0]!.id,
    },
  });
  scope = {
    projectId: project.id,
    repositoryId: project.repositories[0]!.id,
    worktreeId: worktree.id,
  };
  app = buildApp({ prisma });
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

describe("T-004 lifecycle authority", () => {
  const createBody = (title: string) => ({
    title,
    priority: "High",
    effort: "M",
    evidenceState: "Confirmed",
    ...scope,
    finding: "A concrete finding.",
    description: "A bounded intended result.",
    research: ["Research with `inline code`."],
    validation: ["Run the focused validation."],
    tags: ["lifecycle"],
    userSources: [],
  });

  async function createItem(title = `Lifecycle ${randomUUID()}`) {
    const response = await app!.inject({
      method: "POST",
      url: "/api/actionables",
      payload: createBody(title),
    });
    expect(response.statusCode).toBe(201);
    return response.json().item;
  }

  async function move(
    item: any,
    status: Status,
    options: { reason?: string; completionOverrideReason?: string } = {},
    expectedStatus = 200,
  ) {
    const response = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/status-transitions`,
      payload: { version: item.version, status, origin: "user", ...options },
    });
    expect(response.statusCode).toBe(expectedStatus);
    return response;
  }

  async function prepareStatus(status: Status) {
    let item = await createItem();
    if (status === "Inbox") return item;
    if (status === "Researching")
      return (await move(item, "Researching")).json().item;
    item = (await move(item, "Researching")).json().item;
    if (status === "Ready") return (await move(item, "Ready")).json().item;
    if (status === "In progress") {
      item = (await move(item, "Ready")).json().item;
      return (await move(item, "In progress")).json().item;
    }
    if (status === "Blocked") {
      return (
        await move(item, "Blocked", { reason: "Waiting for test access." })
      ).json().item;
    }
    if (status === "Done") {
      item = (await move(item, "Ready")).json().item;
      item = (await move(item, "In progress")).json().item;
      return (
        await move(item, "Done", {
          completionOverrideReason: "Legacy result accepted for this fixture.",
        })
      ).json().item;
    }
    return (
      await move(item, "Dismissed", {
        reason: "No longer part of the intended change.",
      })
    ).json().item;
  }

  const matrix: Record<Status, Status[]> = {
    Inbox: ["Researching", "Dismissed"],
    Researching: ["Inbox", "Ready", "Blocked", "Dismissed"],
    Ready: ["Inbox", "Researching", "In progress", "Blocked", "Dismissed"],
    "In progress": ["Ready", "Blocked", "Done", "Dismissed"],
    Blocked: ["Researching", "Ready", "Dismissed"],
    Done: ["Ready"],
    Dismissed: ["Ready"],
  };

  it("accepts every transition in the approved matrix with its server guard", async () => {
    for (const [from, targets] of Object.entries(matrix) as [
      Status,
      Status[],
    ][]) {
      for (const target of targets) {
        const item = await prepareStatus(from);
        const response = await move(item, target, {
          reason:
            target === "Blocked"
              ? "Waiting for a meaningful prerequisite."
              : target === "Dismissed"
                ? "The outcome is no longer intended."
                : from === "Done" || from === "Dismissed"
                  ? "New evidence requires another pass."
                  : undefined,
          completionOverrideReason:
            target === "Done"
              ? "Fixture explicitly exercises override completion."
              : undefined,
        });
        expect(response.json().item.status).toBe(target);
        expect(response.json().item.permittedTransitions).toEqual(
          matrix[target],
        );
      }
    }
  }, 30_000);

  it("rejects a representative invalid transition from every lifecycle state", async () => {
    for (const status of Object.keys(matrix) as Status[]) {
      const item = await prepareStatus(status);
      const response = await move(item, status, {}, 422);
      expect(response.json()).toMatchObject({
        code: "INVALID_STATUS_TRANSITION",
      });
    }
  });

  it("requires the Researching phase and a non-empty Research note before Ready", async () => {
    let item = await createItem();
    expect((await move(item, "Ready", {}, 422)).json()).toMatchObject({
      code: "RESEARCH_PHASE_REQUIRED",
      errors: { status: expect.any(Array) },
    });

    const stored = await prisma!.actionable.update({
      where: { sourceOrdinal: item.id },
      data: { researchJson: [] },
    });
    expect(stored.version).toBe(item.version);
    item = (await move(item, "Researching")).json().item;
    expect((await move(item, "Ready", {}, 422)).json()).toMatchObject({
      code: "RESEARCH_REQUIRED",
      errors: {
        research: expect.any(Array),
        status: expect.any(Array),
      },
    });
  });

  it("allows In progress only from Ready", async () => {
    const blocked = await prepareStatus("Blocked");
    expect((await move(blocked, "In progress", {}, 422)).json()).toMatchObject({
      code: "INVALID_STATUS_TRANSITION",
    });
  });

  it("requires blocker, dismissal, reopening, and override evidence", async () => {
    let item = await prepareStatus("Ready");
    expect((await move(item, "Blocked", {}, 422)).json()).toMatchObject({
      code: "REASON_REQUIRED",
    });
    expect(
      (await move(item, "Blocked", { reason: "--" }, 422)).json(),
    ).toMatchObject({ code: "REASON_REQUIRED" });
    expect((await move(item, "Dismissed", {}, 422)).json()).toMatchObject({
      code: "REASON_REQUIRED",
    });

    item = await prepareStatus("Done");
    expect((await move(item, "Ready", {}, 422)).json()).toMatchObject({
      code: "REASON_REQUIRED",
    });

    item = await prepareStatus("Dismissed");
    expect((await move(item, "Ready", {}, 422)).json()).toMatchObject({
      code: "REASON_REQUIRED",
    });

    item = await prepareStatus("In progress");
    expect((await move(item, "Done", {}, 422)).json()).toMatchObject({
      code: "VALIDATION_REQUIRED",
    });
  });

  it("defines qualifying validation as current Passed evidence after In progress", async () => {
    let item = await prepareStatus("In progress");
    const failed = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/validation-records`,
      payload: {
        version: item.version,
        type: "Automated test",
        outcome: "Failed",
        notes: "The focused suite failed.",
        evidence: "`pnpm test` exited 1.",
        origin: "user",
      },
    });
    expect(failed.statusCode).toBe(200);
    item = failed.json().item;
    expect(item.validationRecords[0].qualifiesForCompletion).toBe(false);
    expect((await move(item, "Done", {}, 422)).json()).toMatchObject({
      code: "VALIDATION_REQUIRED",
    });

    const passed = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/validation-records`,
      payload: {
        version: item.version,
        type: "Command",
        outcome: "Passed",
        notes: "Focused checks passed.",
        evidence: "Exit code `0`.",
        origin: "user",
      },
    });
    expect(passed.statusCode).toBe(200);
    item = passed.json().item;
    expect(item.validationRecords.at(-1)).toMatchObject({
      outcome: "Passed",
      qualifiesForCompletion: true,
    });

    const completed = await move(item, "Done");
    expect(completed.json().item.activity.at(-1)).toMatchObject({
      type: "completion-validated",
      summary: "Completed with qualifying validation",
    });
  });

  it("appends corrections, retains the superseded record, and recalculates qualification", async () => {
    let item = await prepareStatus("In progress");
    const original = (
      await app!.inject({
        method: "POST",
        url: `/api/actionables/${item.id}/validation-records`,
        payload: {
          version: item.version,
          type: "Review",
          outcome: "Passed",
          notes: "Initial review looked complete.",
          evidence: "Review notes.",
          origin: "user",
        },
      })
    ).json().item;
    item = original;
    const originalId = item.validationRecords[0].id;

    const correction = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/validation-records`,
      payload: {
        version: item.version,
        type: "Review",
        outcome: "Partial",
        notes: "Correction: one path was not reviewed.",
        evidence: "Missing mobile evidence.",
        origin: "user",
        supersedesId: originalId,
      },
    });
    expect(correction.statusCode).toBe(200);
    item = correction.json().item;
    expect(item.validationRecords).toHaveLength(2);
    expect(item.validationRecords[0]).toMatchObject({
      id: originalId,
      qualifiesForCompletion: false,
      supersededById: item.validationRecords[1].id,
    });
    expect(item.validationRecords[1]).toMatchObject({
      supersedesId: originalId,
      outcome: "Partial",
    });
    expect(item.activity.at(-1)).toMatchObject({
      type: "validation-corrected",
    });
    expect((await move(item, "Done", {}, 422)).json()).toMatchObject({
      code: "VALIDATION_REQUIRED",
    });
  });

  it("keeps override, dismissal, and reopening visibly distinct without deleting validation", async () => {
    let item = await prepareStatus("In progress");
    const completed = await move(item, "Done", {
      completionOverrideReason:
        "Emergency local completion accepted without a passing check.",
    });
    item = completed.json().item;
    expect(item.activity.at(-1)).toMatchObject({
      type: "completion-overridden",
      context: {
        reason: "Emergency local completion accepted without a passing check.",
      },
    });
    item = (
      await move(item, "Ready", {
        reason: "The override needs normal validation.",
      })
    ).json().item;
    expect(item.activity.at(-1)).toMatchObject({ type: "reopened" });

    const dismissed = await move(item, "Dismissed", {
      reason: "The work is no longer intended.",
    });
    item = dismissed.json().item;
    expect(item.status).toBe("Dismissed");
    expect(item.activity.at(-1)).toMatchObject({ type: "dismissed" });
    const recordCount = item.validationRecords.length;
    item = (
      await move(item, "Ready", {
        reason: "Requirements changed and work resumes.",
      })
    ).json().item;
    expect(item.validationRecords).toHaveLength(recordCount);
    expect(item.activity.at(-1)).toMatchObject({ type: "reopened" });
  });

  it("returns recoverable 409 conflicts for stale lifecycle and validation actions", async () => {
    let item = await prepareStatus("Ready");
    const stale = { ...item };
    item = (await move(item, "In progress")).json().item;
    const staleTransition = await move(stale, "Researching", {}, 409);
    expect(staleTransition.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { version: item.version, status: "In progress" },
    });

    const staleValidation = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/validation-records`,
      payload: {
        version: stale.version,
        type: "Command",
        outcome: "Passed",
        notes: "Stale evidence.",
        evidence: "Should not persist.",
        origin: "user",
      },
    });
    expect(staleValidation.statusCode).toBe(409);
    expect(staleValidation.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { version: item.version },
    });
  });

  it("rolls back lifecycle and evidence mutations when append-only persistence fails", async () => {
    let item = await prepareStatus("Ready");
    const record = await prisma!.actionable.findUniqueOrThrow({
      where: { sourceOrdinal: item.id },
      select: { id: true, version: true, status: true },
    });
    await prisma!.$executeRawUnsafe(`
      CREATE TRIGGER fail_activity BEFORE INSERT ON ActivityEvent
      WHEN NEW.actionableId = '${record.id}'
      BEGIN SELECT RAISE(ABORT, 'activity failure'); END
    `);
    const failedTransition = await move(item, "In progress", {}, 500);
    expect(failedTransition.json()).toMatchObject({ code: "INTERNAL_ERROR" });
    await prisma!.$executeRawUnsafe("DROP TRIGGER fail_activity");
    expect(
      await prisma!.actionable.findUniqueOrThrow({
        where: { id: record.id },
        select: { version: true, status: true },
      }),
    ).toEqual({ version: record.version, status: record.status });

    item = (await move(item, "In progress")).json().item;
    await prisma!.$executeRawUnsafe(`
      CREATE TRIGGER fail_validation BEFORE INSERT ON ValidationRecord
      WHEN NEW.actionableId = '${record.id}'
      BEGIN SELECT RAISE(ABORT, 'validation failure'); END
    `);
    const failedEvidence = await app!.inject({
      method: "POST",
      url: `/api/actionables/${item.id}/validation-records`,
      payload: {
        version: item.version,
        type: "Command",
        outcome: "Passed",
        notes: "Would pass.",
        evidence: "Must roll back.",
        origin: "user",
      },
    });
    expect(failedEvidence.statusCode).toBe(500);
    await prisma!.$executeRawUnsafe("DROP TRIGGER fail_validation");
    expect(
      await prisma!.actionable.findUniqueOrThrow({
        where: { id: record.id },
        select: { version: true },
      }),
    ).toEqual({ version: item.version });
    expect(
      await prisma!.validationRecord.count({
        where: { actionableId: record.id },
      }),
    ).toBe(0);
  });
});
