import Database from "better-sqlite3";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  codexPromptTemplateSchema,
  defaultCodexImplementationPrompt,
  defaultCodexResearchPrompt,
  renderCodexStartPrompt,
  renderCodexSubtaskPrompt,
  eligibleCodexSubtasks,
  type InspectAgentTaskResponse,
  type ActionableDetail,
} from "@actionables/contracts";

const templates = {
  codexResearchPrompt: defaultCodexResearchPrompt,
  codexImplementationPrompt: defaultCodexImplementationPrompt,
};
const task = {
  id: 47,
  workItemId: 42,
  parentId: 42,
  title: "Literal {{taskId}} & $&\n日本語",
  status: "Inbox",
  relationships: { subtasks: [] },
};

describe("Codex prompt templates", () => {
  it("shows equally eligible leaves and waits to finalize nested parents until their children are terminal", () => {
    const item = (
      id: number,
      overrides: Partial<InspectAgentTaskResponse["task"]> = {},
    ) =>
      ({
        id,
        workItemId: 534,
        parentId: 534,
        childCount: 0,
        status: "Ready",
        version: 1,
        availableForClaim: true,
        readiness: { requiredForReady: [], blockers: [] },
        ...overrides,
      }) as InspectAgentTaskResponse["task"];
    const inventory = {
      task: item(534, { parentId: null }),
      nextAfterId: null,
      descendants: [
        item(536, { status: "Done", availableForClaim: false }),
        item(537),
        item(538),
        item(539, { availableForClaim: false }),
        item(540, { childCount: 1 }),
        item(541, { parentId: 540 }),
        item(542, { status: "Dismissed", availableForClaim: false }),
      ],
    };
    expect(eligibleCodexSubtasks(inventory).map((task) => task.id)).toEqual([
      537, 538, 541,
    ]);
    inventory.descendants[5] = item(541, {
      parentId: 540,
      status: "Done",
      availableForClaim: false,
    });
    expect(eligibleCodexSubtasks(inventory).map((task) => task.id)).toEqual([
      537, 538, 540,
    ]);
    inventory.task.availableForClaim = false;
    expect(eligibleCodexSubtasks(inventory)).toEqual([]);
  });

  it("keeps next-child and sequential authorization explicit with root, scope and prerequisite references", () => {
    const child = {
      ...task,
      id: 537,
      workItemId: 534,
      status: "Ready",
      scope: {
        projectName: "Dashboard",
        repositoryName: "Actionables",
        worktreeName: "Default",
      },
      relationships: {
        subtasks: [],
        blockedBy: [
          {
            prerequisite: {
              id: 536,
              title: "Completed prerequisite",
              status: "Done",
            },
          },
        ],
      },
    } as unknown as ActionableDetail;
    const parent = { id: 535, workItemId: 534 };
    const next = renderCodexSubtaskPrompt(parent, child, templates, "next")!;
    expect(next).toContain("work item #534. Claim task #537");
    expect(next).toContain(
      "Scope: project Dashboard, repository Actionables, worktree Default.",
    );
    expect(next).toContain("#536 (Completed prerequisite)");
    expect(next).toContain(
      "only #537; do not start another child automatically",
    );
    const sequential = renderCodexSubtaskPrompt(
      parent,
      child,
      templates,
      "sequential",
    )!;
    expect(sequential).toContain(
      "only within parent #535's subtree under original workItemId #534",
    );
    expect(sequential).toContain("before every claim");
    expect(sequential).toContain("verify it is Done before starting the next");
    expect(sequential).toContain(
      "Stop for business decisions or required approvals",
    );
    expect(sequential).toContain(
      "do not mark the parent Done merely because its children are terminal",
    );
    expect(
      renderCodexSubtaskPrompt(
        parent,
        { ...child, status: "Done" },
        templates,
        "next",
      ),
    ).toBeNull();
    expect(
      renderCodexSubtaskPrompt(
        { ...parent, workItemId: 1 },
        child,
        templates,
        "next",
      ),
    ).toBeNull();
  });
  it.each([
    ["Inbox", "begin the Researching phase"],
    ["Researching", "resume the Researching phase"],
    ["Ready", "continue from Ready"],
    ["In progress", "resume implementation from In progress"],
  ])("preserves the default %s start and governing IDs", (status, phase) => {
    const prompt = renderCodexStartPrompt({ ...task, status }, templates);
    expect(prompt).toContain(
      `Use Actionables work item #42. Claim task #47 and ${phase}.`,
    );
    expect(prompt).not.toContain(task.title);
    expect(prompt).toContain("inspect `isError`");
    expect(prompt).toContain("task.truncation.reconciliationGuidance");
  });

  it("replaces every listed variable once without interpreting inserted title text", () => {
    const custom =
      "{{workItemId}}|{{taskId}}|{{taskTitle}}|{{phaseAction}}|{{splitInstructions}}|{{implementationInstructions}}";
    const prompt = renderCodexStartPrompt(
      { ...task, status: "Ready" },
      { ...templates, codexImplementationPrompt: custom },
    );
    expect(prompt).toContain(`42|47|${task.title}|continue from Ready|`);
    expect(prompt).toContain("use #42 as `workItemId` and #47 as `parentId`");
    expect(prompt).toContain(
      "Before requesting Ready or moving Ready to In progress",
    );
    expect(prompt).toContain(
      "Confirm the scope, then move the task to In progress before editing",
    );
  });

  it("preserves root splitting and coordination finalization", () => {
    const root = { ...task, workItemId: 47, parentId: undefined };
    expect(renderCodexStartPrompt(root, templates)).toContain(
      "use #47 as `workItemId` and #47 as `parentId`",
    );
    const coordination = {
      ...root,
      status: "Ready",
      relationships: { subtasks: [{}] },
    };
    expect(renderCodexStartPrompt(coordination, templates)).toContain(
      "do not implement or duplicate any child task's scope",
    );
    expect(renderCodexStartPrompt(coordination, templates)).toContain(
      "move this task to In progress before finalizing it",
    );
    const resumed = renderCodexStartPrompt(
      { ...coordination, status: "In progress" },
      templates,
    );
    expect(resumed).toContain("Otherwise finalize this task");
    expect(resumed).not.toContain("Before requesting Ready");
    const nested = renderCodexStartPrompt(
      { ...coordination, workItemId: 12, parentId: 42 },
      templates,
    );
    expect(nested).toContain("Use Actionables work item #12. Claim task #47");
    expect(nested).toContain("coordination record for its subtree");
  });

  it.each(["Done", "Dismissed", "Blocked"])(
    "does not generate a start for %s",
    (status) => {
      expect(renderCodexStartPrompt({ ...task, status }, templates)).toBeNull();
    },
  );

  it.each([
    "{{workItemId}} {{taskId}} {{unknown}}",
    "{{workItemId}} {{taskId}} {{__proto__}}",
    "{{workItemId}} {{taskId}} {{constructor}}",
    "{{workItemId}} {{taskId}} {{taskTitle",
    "{{workItemId}} {{taskId}} taskTitle}}",
    "{{workItemId}} {{taskId}} {{{taskTitle}}}",
    "{{workItemId}} {{taskId}} {{taskId + 1}}",
    "{{workItemId}} {{taskId}} {{}}",
    "{{workItemId}}",
    "{{taskId}}",
    " ",
    "{{workItemId}} {{taskId}}" + "x".repeat(20_000),
  ])("rejects invalid or incomplete templates", (template) => {
    expect(codexPromptTemplateSchema.safeParse(template).success).toBe(false);
    expect(() =>
      renderCodexStartPrompt(task, {
        ...templates,
        codexResearchPrompt: template,
      }),
    ).toThrow();
  });

  it("keeps ordinary braces and code as literal template text", () => {
    const template =
      '{{workItemId}} {{taskId}} {"example": true} ${process.exit()}';
    expect(
      renderCodexStartPrompt(task, {
        ...templates,
        codexResearchPrompt: template,
      }),
    ).toBe('42 47 {"example": true} ${process.exit()}');
  });

  it("adds nullable fields without altering a populated older settings row", async () => {
    const directory = new URL("../../../prisma/migrations/", import.meta.url);
    const target = "20260911230000_codex_start_prompts";
    const database = new Database(":memory:");
    try {
      const migrations = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name < target)
        .map((entry) => entry.name)
        .sort();
      for (const migration of migrations) {
        database.exec(
          await readFile(
            new URL(`${migration}/migration.sql`, directory),
            "utf8",
          ),
        );
      }
      database
        .prepare(
          `INSERT INTO "HelperAgentSettings" ("id", "inboxTriagerPrompt", "noteGroomerPrompt", "relationshipAuditorPrompt", "version", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "helper-agents",
          "Keep triage",
          "Keep notes",
          "Keep relationships",
          9,
          "2026-09-11T00:00:00.000Z",
        );
      const before = database
        .prepare('SELECT * FROM "HelperAgentSettings"')
        .get();
      database.exec(
        await readFile(new URL(`${target}/migration.sql`, directory), "utf8"),
      );
      expect(
        database.prepare('SELECT * FROM "HelperAgentSettings"').get(),
      ).toEqual({
        ...(before as object),
        codexResearchPrompt: null,
        codexImplementationPrompt: null,
      });
    } finally {
      database.close();
    }
  });
});
