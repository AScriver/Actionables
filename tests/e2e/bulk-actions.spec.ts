import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { ActionableDetail } from "@actionables/contracts";
import { createPrismaClient } from "../../apps/api/src/database";

if (
  !process.env.DATABASE_URL ||
  /(?:^|[/\\])actionables\.db$/i.test(process.env.DATABASE_URL)
) {
  throw new Error("Bulk tests require an explicit isolated DATABASE_URL.");
}

async function detail(page: Page, id: number): Promise<ActionableDetail> {
  const response = await page.request.get(`/api/actionables/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).item;
}

async function create(
  page: Page,
  title: string,
  tags: string[] = [],
  scope?: { projectId: string; repositoryId: string; worktreeId: string },
) {
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects[0];
  const repository = project.repositories[0];
  const response = await page.request.post("/api/actionables", {
    data: {
      title,
      tags,
      priority: "Medium",
      effort: "S",
      evidenceState: "Confirmed",
      projectId: project.id,
      repositoryId: repository.id,
      worktreeId: repository.worktrees[0].id,
      ...scope,
      finding: `Finding for ${title}`,
      description: `Result for ${title}`,
      resolution: "Fixture resolution",
      research: ["Fixture research"],
      validation: ["Fixture check"],
      userSources: [{ type: "Text", locator: "Keep this source" }],
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).item as ActionableDetail;
}

async function transition(page: Page, id: number, status: string) {
  const response = await page.request.post(
    `/api/actionables/${id}/status-transitions`,
    {
      data: {
        version: (await detail(page, id)).version,
        status,
        reason: "Fixture transition",
        origin: "user",
      },
    },
  );
  expect(response.ok()).toBe(true);
}

async function attach(
  page: Page,
  child: ActionableDetail,
  parent: ActionableDetail,
) {
  const response = await page.request.put(
    `/api/actionables/${child.id}/parent`,
    {
      data: {
        version: (await detail(page, child.id)).version,
        parentId: parent.id,
        parentVersion: (await detail(page, parent.id)).version,
      },
    },
  );
  expect(response.ok()).toBe(true);
}

function checkbox(page: Page, item: { id: number; title: string }) {
  return page.getByRole("checkbox", {
    name: `Select #${item.id} ${item.title}`,
    exact: true,
  });
}

test("selection stays visible, supports keyboard, and leaves row opening independent", async ({
  page,
}) => {
  const tag = `selection-${randomUUID()}`;
  const parent = await create(page, `${tag} parent`, [tag]);
  const child = await create(page, `${tag} child`, [tag]);
  const other = await create(page, `${tag} other`, [tag]);
  await attach(page, child, parent);
  await page.goto("/");
  await expect(checkbox(page, parent)).toBeVisible();
  await expect(checkbox(page, child)).toHaveCount(0);
  const all = page.getByRole("checkbox", {
    name: "Select all shown Actionables",
  });
  await checkbox(page, parent).focus();
  await page.keyboard.press("Space");
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(all).toBeChecked({ indeterminate: true });
  await expect(page).not.toHaveURL(new RegExp(`/actionables/${parent.id}`));
  await page.locator(`[data-actionable-id="${other.id}"]`).press("Enter");
  await expect(page).toHaveURL(new RegExp(`/actionables/${other.id}`));
  await expect(checkbox(page, parent)).toBeChecked();
  const shown = await page.locator(".finding-row").count();
  await all.check();
  await expect(
    page.getByText(`${shown} selected`, { exact: true }),
  ).toBeVisible();
  await expect(checkbox(page, child)).toHaveCount(0);
  await page.getByRole("button", { name: "Clear selection" }).click();
  await checkbox(page, parent).check();
  await checkbox(page, other).check();
  await page
    .getByRole("button", { name: `Expand subtasks for ${parent.title}` })
    .click();
  await checkbox(page, child).check();
  await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: `Collapse subtasks for ${parent.title}` })
    .click();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Expand subtasks for " + parent.title })
    .click();
  await expect(checkbox(page, child)).not.toBeChecked();
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(all).not.toBeChecked();
  await checkbox(page, parent).check();
  await page.getByLabel("Search actionables").fill(other.title);
  await expect(checkbox(page, parent)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Dismiss selected", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Search actionables").fill("");
  await expect(checkbox(page, parent)).not.toBeChecked();
  await checkbox(page, parent).check();
  await page
    .getByRole("columnheader")
    .filter({ hasText: "Priority" })
    .getByRole("button")
    .click();
  // Priority is the default; a real sort/context change uses Finding.
  await page
    .getByRole("columnheader")
    .filter({ hasText: "Finding" })
    .getByRole("button")
    .click();
  await expect(checkbox(page, parent)).not.toBeChecked();
  await checkbox(page, parent).check();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Clear selection" }),
  ).toHaveCount(0);
  await page.goBack();
  await expect(checkbox(page, parent)).not.toBeChecked();
});

test("dismissal confirms selected items, preserves unselected descendants and claims, and audits every reason", async ({
  page,
}) => {
  const prefix = `dismiss-${randomUUID()}`;
  const parent = await create(page, `${prefix} parent`);
  const child = await create(page, `${prefix} child`);
  const untouched = await create(page, `${prefix} untouched`);
  const terminal = await create(page, `${prefix} terminal`);
  await attach(page, child, parent);
  await attach(page, untouched, parent);
  await transition(page, terminal.id, "Dismissed");
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    await prisma.agentTaskClaim.create({
      data: {
        actionableId: child.recordId,
        agentId: "bulk-browser-fixture",
        claimTokenHash: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 600_000),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
  await page.goto(`/?q=${prefix}&status=all`);
  for (const item of [parent, child, terminal])
    await checkbox(page, item).check();
  await page
    .getByRole("button", { name: "Dismiss selected", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Dismiss selected Actionables",
  });
  await expect(dialog.getByRole("status")).toContainText(
    "2 eligible · 1 excluded",
  );
  await expect(dialog).toContainText("An agent claim exists");
  await expect(dialog).toContainText(
    "2 descendants; only selected descendants change",
  );
  await expect(
    dialog.getByRole("button", { name: "Confirm dismiss 2" }),
  ).toBeDisabled();
  await dialog.getByLabel("Dismissal reason").fill("   ");
  await expect(
    dialog.getByRole("button", { name: "Confirm dismiss 2" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await detail(page, parent.id)).status).toBe("Inbox");
  await page
    .getByRole("button", { name: "Dismiss selected", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Dismissal reason")
    .fill("No longer planned together.");
  await dialog.getByRole("button", { name: "Confirm dismiss 2" }).click();
  await expect(dialog.getByRole("status")).toContainText("2 succeeded");
  await expect(dialog).toContainText(
    "Skipped — Dismissed cannot be dismissed.",
  );
  for (const item of [parent, child]) {
    const saved = await detail(page, item.id);
    expect(saved.status).toBe("Dismissed");
    expect(
      saved.activity.filter((event) => event.type === "dismissed"),
    ).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          reason: "No longer planned together.",
          origin: "user",
        }),
      }),
    ]);
  }
  expect((await detail(page, child.id)).agentClaim?.agentId).toBe(
    "bulk-browser-fixture",
  );
  expect((await detail(page, untouched.id)).status).toBe("Inbox");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(checkbox(page, parent)).not.toBeChecked();
});

test("partial failure and stale versions require fresh review without replaying successes", async ({
  page,
}) => {
  const prefix = `stale-${randomUUID()}`;
  const first = await create(page, `${prefix} first`);
  const stale = await create(page, `${prefix} stale`);
  await page.goto(`/?q=${prefix}&status=all`);
  await page
    .getByRole("checkbox", { name: "Select all shown Actionables" })
    .check();
  await page
    .getByRole("button", { name: "Dismiss selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText("2 eligible");
  await transition(page, stale.id, "Researching");
  await dialog.getByLabel("Dismissal reason").fill("A common reason.");
  await dialog.getByRole("button", { name: "Confirm dismiss 2" }).click();
  await expect(dialog.getByRole("status")).toContainText("1 succeeded");
  await expect(dialog).toContainText(
    "Current state: Researching. Review again before retrying.",
  );
  await dialog.getByRole("button", { name: "Review remaining" }).click();
  await expect(dialog.getByLabel("Dismissal reason")).toHaveValue(
    "A common reason.",
  );
  await dialog.getByRole("button", { name: "Confirm dismiss 1" }).click();
  await expect(dialog.getByRole("status")).toContainText("2 succeeded");
  expect(
    (await detail(page, first.id)).activity.filter(
      (event) => event.type === "dismissed",
    ),
  ).toHaveLength(1);
  expect((await detail(page, stale.id)).status).toBe("Dismissed");
});

test("lost responses reconcile and duplicate submissions never repeat a write", async ({
  page,
}) => {
  const prefix = `uncertain-${randomUUID()}`;
  const item = await create(page, prefix);
  let submissions = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/actionables/${item.id}/status-transitions`,
    async (route) => {
      submissions++;
      await pending;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    },
  );
  await page.goto(`/?q=${prefix}&status=all`);
  await checkbox(page, item).check();
  await page
    .getByRole("button", { name: "Dismiss selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Dismissal reason")
    .fill("Confirm after connection loss.");
  const confirm = dialog.getByRole("button", { name: "Confirm dismiss 1" });
  await confirm.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(
    dialog.getByRole("button", { name: "Applying…" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog).toContainText(
    "Dismissal verified after the response was interrupted.",
  );
  await expect(dialog.getByRole("status")).toContainText("1 succeeded");
  expect(submissions).toBe(1);
  expect(
    (await detail(page, item.id)).activity.filter(
      (event) => event.type === "dismissed",
    ),
  ).toHaveLength(1);
});

test("unavailable readback stays uncertain until refreshed and never repeats the saved action", async ({
  page,
}) => {
  const item = await create(page, `offline-${randomUUID()}`);
  let offline = false;
  let writes = 0;
  await page.route(`**/api/actionables/${item.id}`, async (route) => {
    if (offline) await route.abort("failed");
    else await route.continue();
  });
  await page.route(
    `**/api/actionables/${item.id}/status-transitions`,
    async (route) => {
      writes++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      offline = true;
      await route.abort("failed");
    },
  );
  await page.goto(`/?q=${item.title}&status=all`);
  await checkbox(page, item).check();
  await page
    .getByRole("button", { name: "Dismiss selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Dismissal reason").fill("Recover when online.");
  await dialog.getByRole("button", { name: "Confirm dismiss 1" }).click();
  await expect(dialog).toContainText(
    "Uncertain — Outcome could not be verified",
  );
  await dialog.getByRole("button", { name: "Review remaining" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "0 eligible · 1 excluded",
  );
  await expect(
    dialog.getByRole("button", { name: "Confirm dismiss 0" }),
  ).toBeDisabled();
  offline = false;
  await dialog.getByRole("button", { name: "Review remaining" }).click();
  await expect(dialog).toContainText(
    "Dismissal verified from current history.",
  );
  await expect(dialog.getByRole("status")).toContainText("1 succeeded");
  expect(writes).toBe(1);
});

test("bulk archive and restore preserve parent/child content, status and relationships", async ({
  page,
}) => {
  const prefix = `archive-${randomUUID()}`;
  const parent = await create(page, `${prefix} parent`);
  const child = await create(page, `${prefix} child`);
  const untouched = await create(page, `${prefix} untouched`);
  await attach(page, child, parent);
  await attach(page, untouched, parent);
  expect(
    (
      await page.request.post(`/api/actionables/${untouched.id}/dependencies`, {
        data: {
          version: (await detail(page, untouched.id)).version,
          prerequisiteId: parent.id,
          prerequisiteVersion: (await detail(page, parent.id)).version,
        },
      })
    ).ok(),
  ).toBe(true);
  const before = [await detail(page, parent.id), await detail(page, child.id)];
  await page.goto(`/?q=${prefix}&status=all`);
  await checkbox(page, parent).check();
  await checkbox(page, child).check();
  await page
    .getByRole("button", { name: "Archive selected", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Archive selected Actionables",
  });
  await expect(dialog.getByRole("status")).toContainText("2 eligible");
  await expect(dialog).toContainText("2 active subtasks will be hidden.");
  await expect(dialog).toContainText(
    "This actionable is a subtask; its parent relationship will be preserved.",
  );
  await expect(dialog).toContainText(
    "1 dependent actionable will keep this prerequisite relationship.",
  );
  await page.screenshot({
    path: "output/playwright/task528-archive.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await detail(page, parent.id)).archiveState.isArchived).toBe(false);
  await page
    .getByRole("button", { name: "Archive selected", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm archive 2" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "2 succeeded",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(checkbox(page, parent)).toHaveCount(0);
  expect((await detail(page, untouched.id)).archiveState.directlyArchived).toBe(
    false,
  );
  expect((await detail(page, untouched.id)).isDependencyBlocked).toBe(true);
  await page.goto(`/archive?q=${prefix}&status=all`);
  let restoreWrites = 0;
  await page.route(`**/api/actionables/${child.id}/restore`, async (route) => {
    restoreWrites++;
    expect((await route.fetch()).ok()).toBe(true);
    await route.abort("failed");
  });
  await expect(checkbox(page, parent)).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Select all shown Actionables" })
    .check();
  await page.locator(`[data-actionable-id="${parent.id}"]`).press("Enter");
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Restore selected", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Restore selected Actionables" });
  await expect(dialog.getByRole("status")).toContainText("2 eligible");
  await expect(dialog).not.toContainText("will be hidden");
  await dialog.getByRole("button", { name: "Confirm restore 2" }).click();
  await expect(dialog.getByRole("status")).toContainText("2 succeeded");
  await expect(dialog).toContainText(
    "Restore verified after the response was interrupted.",
  );
  expect(restoreWrites).toBe(1);
  for (const original of before) {
    const saved = await detail(page, original.id);
    expect(saved).toMatchObject({
      title: original.title,
      status: original.status,
      finding: original.finding,
      description: original.description,
      resolution: original.resolution,
      research: original.research,
      validation: original.validation,
      tags: original.tags,
      userSources: original.userSources,
      archiveState: { isArchived: false, directlyArchived: false },
    });
    expect(saved.parentId).toEqual(original.parentId);
    expect(saved.childIds).toEqual(original.childIds);
    expect(
      saved.activity
        .filter((event) => ["archived", "restored"].includes(event.type))
        .map((event) => event.type)
        .sort(),
    ).toEqual(["archived", "restored"]);
  }
});

test("bulk restore excludes inherited archive states without restoring scopes", async ({
  page,
}) => {
  const prefix = `inherited-${randomUUID()}`;
  const direct = await create(page, `${prefix} direct`);
  const active = await create(page, `${prefix} active`);
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const project = await prisma.project.create({
    data: {
      name: `ZZ ${prefix}`,
      externalKey: prefix,
      repositories: { create: { name: prefix, externalKey: prefix } },
    },
    include: { repositories: true },
  });
  const worktree = await prisma.worktree.create({
    data: {
      name: prefix,
      externalKey: prefix,
      projectId: project.id,
      repositoryId: project.repositories[0]!.id,
    },
  });
  await prisma.$disconnect();
  const scope = {
    projectId: project.id,
    repositoryId: worktree.repositoryId,
    worktreeId: worktree.id,
  };
  const inherited = await create(page, `${prefix} inherited`, [], scope);
  const both = await create(page, `${prefix} both`, [], scope);
  for (const item of [direct, both]) {
    expect(
      (
        await page.request.post(`/api/actionables/${item.id}/archive`, {
          data: { version: item.version },
        })
      ).ok(),
    ).toBe(true);
  }
  expect(
    (
      await page.request.post(`/api/scopes/worktree/${worktree.id}/archive`, {
        data: { version: worktree.version },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/?q=${prefix}&archived=all&status=all`);
  await page
    .getByRole("checkbox", { name: "Select all shown Actionables" })
    .check();
  await expect(page.getByText("4 selected", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Restore selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText(
    "1 eligible · 3 excluded",
  );
  await expect(
    dialog.getByText("Excluded — Restore the archived worktree first."),
  ).toHaveCount(2);
  await expect(dialog).toContainText("Not directly archived.");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    (await new AxeBuilder({ page }).include(".bulk-dialog").analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: "output/playwright/task528-restore-390.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Confirm restore 1" }).click();
  await expect(dialog.getByRole("status")).toContainText("1 succeeded");
  expect((await detail(page, direct.id)).archiveState.isArchived).toBe(false);
  expect((await detail(page, active.id)).version).toBe(active.version);
  expect((await detail(page, inherited.id)).archiveState).toMatchObject({
    directlyArchived: false,
    inheritedFrom: ["worktree"],
  });
  expect((await detail(page, both.id)).archiveState).toMatchObject({
    directlyArchived: true,
    inheritedFrom: ["worktree"],
  });
});

test("archive handles stale and interrupted writes without repeating successful items", async ({
  page,
}) => {
  const prefix = `archive-retry-${randomUUID()}`;
  const interrupted = await create(page, `${prefix} interrupted`);
  const stale = await create(page, `${prefix} stale`);
  let writes = 0;
  await page.route(
    `**/api/actionables/${interrupted.id}/archive`,
    async (route) => {
      writes++;
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort("failed");
    },
  );
  await page.goto(`/?q=${prefix}&status=all`);
  await page
    .getByRole("checkbox", { name: "Select all shown Actionables" })
    .check();
  await page
    .getByRole("button", { name: "Archive selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText("2 eligible");
  await transition(page, stale.id, "Researching");
  await dialog.getByRole("button", { name: "Confirm archive 2" }).click();
  await expect(dialog).toContainText(
    "Archive verified after the response was interrupted.",
  );
  await expect(dialog).toContainText(
    "Current state: Researching. Review again before retrying.",
  );
  await expect(dialog.getByRole("status")).toContainText("1 succeeded");
  await dialog.getByRole("button", { name: "Review remaining" }).click();
  await dialog.getByRole("button", { name: "Confirm archive 1" }).click();
  await expect(dialog.getByRole("status")).toContainText("2 succeeded");
  expect(writes).toBe(1);
  expect((await detail(page, stale.id)).status).toBe("Researching");
  expect(
    (await detail(page, interrupted.id)).activity.filter(
      (event) => event.type === "archived",
    ),
  ).toHaveLength(1);
});

test("archive impact failures and mismatched versions must be reviewed before writing", async ({
  page,
}) => {
  const item = await create(page, `impact-${randomUUID()}`);
  let mode = "offline";
  let writes = 0;
  await page.route(
    `**/api/archive-impact/actionable/${item.id}`,
    async (route) => {
      if (mode === "offline") {
        await route.abort("failed");
        return;
      }
      if (mode === "mismatch") await transition(page, item.id, "Researching");
      await route.continue();
    },
  );
  await page.route(`**/api/actionables/${item.id}/archive`, async (route) => {
    writes++;
    await route.continue();
  });
  await page.goto(`/?q=${item.title}`);
  await checkbox(page, item).check();
  await page
    .getByRole("button", { name: "Archive selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Confirm archive 0" }),
  ).toBeDisabled();
  await expect(dialog).toContainText("Could not reach the API.");
  mode = "mismatch";
  await dialog.getByRole("button", { name: "Review remaining" }).click();
  await expect(dialog).toContainText(
    "Changed while checking impact. Review again.",
  );
  expect(writes).toBe(0);
  mode = "ready";
  await dialog.getByRole("button", { name: "Review remaining" }).click();
  await dialog.getByRole("button", { name: "Confirm archive 1" }).click();
  await expect(dialog.getByRole("status")).toContainText("1 succeeded");
  expect(writes).toBe(1);
});

test("bulk priority and effort preserve each item's content, sources, status, scope and claim", async ({
  page,
}) => {
  const prefix = `metadata-${randomUUID()}`;
  const first = await create(page, `${prefix} first`);
  const second = await create(page, `${prefix} second`);
  const untouched = await create(page, `${prefix} untouched`);
  await attach(page, second, first);
  await transition(page, second.id, "Researching");
  await transition(page, second.id, "Blocked");
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    await prisma.actionable.update({
      where: { id: first.recordId },
      data: {
        priority: "Low",
        effort: "XS",
        researchJson: ["First multiline note\nSecond line"],
        validationJson: ["First check\nSecond line"],
      },
    });
    await prisma.actionable.update({
      where: { id: second.recordId },
      data: { priority: "High", effort: "XL" },
    });
    await prisma.agentTaskClaim.create({
      data: {
        actionableId: second.recordId,
        agentId: "metadata-browser-fixture",
        claimTokenHash: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 600_000),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
  expect(
    (
      await page.request.post(`/api/actionables/${second.id}/archive`, {
        data: { version: (await detail(page, second.id)).version },
      })
    ).ok(),
  ).toBe(true);
  const before = [await detail(page, first.id), await detail(page, second.id)];
  await page.goto(`/?q=${prefix}&status=all&archived=all`);
  for (const [field, value] of [
    ["priority", "Critical"],
    ["effort", "L"],
  ]) {
    for (const item of before) await checkbox(page, item).check();
    await page
      .getByRole("button", { name: "Edit selected", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Edit selected Actionables",
    });
    await dialog.getByLabel("Field to change").selectOption(field!);
    await dialog.getByLabel("New value").selectOption(value!);
    await expect(dialog.getByRole("status")).toContainText("2 eligible");
    await expect(dialog).toContainText(`→ ${value}`);
    await dialog.getByRole("button", { name: "Confirm edit 2" }).click();
    await expect(dialog.getByRole("status")).toContainText("2 succeeded");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }
  for (const original of before) {
    const saved = await detail(page, original.id);
    expect(saved).toMatchObject({
      priority: "Critical",
      effort: "L",
      version: original.version + 2,
    });
    for (const key of [
      "title",
      "status",
      "finding",
      "description",
      "resolution",
      "research",
      "validation",
      "tags",
      "userSources",
      "scope",
      "files",
      "sourceThread",
      "immutableSourceEvidence",
      "statusHistory",
      "validationRecords",
      "activity",
      "agentClaim",
      "manualBlocker",
      "parentId",
      "childIds",
      "archiveState",
    ] as const) {
      expect(saved[key], key).toEqual(original[key]);
    }
    expect(saved.relationships.parent?.id).toEqual(
      original.relationships.parent?.id,
    );
    expect(saved.relationships.subtasks.map((edge) => edge.id)).toEqual(
      original.relationships.subtasks.map((edge) => edge.id),
    );
  }
  expect((await detail(page, untouched.id)).version).toBe(untouched.version);
});

test("bulk tags preserve unrelated tags, skip no-ops and enforce each resulting limit", async ({
  page,
}) => {
  const prefix = `tags-${randomUUID()}`;
  const first = await create(page, `${prefix} first`, ["Keep", "UI"]);
  const second = await create(page, `${prefix} second`, ["Different"]);
  const full = await create(
    page,
    `${prefix} full`,
    Array.from({ length: 30 }, (_, index) => `tag-${index}`),
  );
  await transition(page, full.id, "Dismissed");
  const fullBefore = await detail(page, full.id);
  await page.goto(`/?q=${prefix}&status=all`);
  await page
    .getByRole("checkbox", { name: "Select all shown Actionables" })
    .check();
  await page
    .getByRole("button", { name: "Edit selected", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Field to change").selectOption("add-tags");
  for (const invalid of ["   ", "valid, , other", "x".repeat(61)]) {
    await dialog.getByLabel("New value").fill(invalid);
    await expect(
      dialog.getByRole("button", { name: "Confirm edit 0" }),
    ).toBeDisabled();
    expect((await detail(page, first.id)).version).toBe(first.version);
  }
  await dialog.getByLabel("New value").fill("UI, New, new");
  await expect(dialog.getByRole("status")).toContainText(
    "2 eligible · 1 excluded",
  );
  await expect(dialog).toContainText("30");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    (await new AxeBuilder({ page }).include(".bulk-dialog").analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: "output/playwright/task528-tags-390.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Confirm edit 2" }).click();
  await expect(dialog.getByRole("status")).toContainText("2 succeeded");
  expect((await detail(page, first.id)).tags).toEqual(["Keep", "UI", "New"]);
  expect((await detail(page, second.id)).tags).toEqual([
    "Different",
    "UI",
    "New",
  ]);
  expect((await detail(page, full.id)).version).toBe(fullBefore.version);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Select all shown Actionables" })
    .check();
  await page
    .getByRole("button", { name: "Edit selected", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Field to change").selectOption("remove-tags");
  await dialog.getByLabel("New value").fill("uI, tag-0, absent");
  await dialog.getByRole("button", { name: "Confirm edit 3" }).click();
  await expect(dialog.getByRole("status")).toContainText("3 succeeded");
  expect((await detail(page, first.id)).tags).toEqual(["Keep", "New"]);
  expect((await detail(page, second.id)).tags).toEqual(["Different", "New"]);
  expect(await detail(page, full.id)).toMatchObject({
    status: "Dismissed",
    tags: fullBefore.tags.slice(1),
    version: fullBefore.version + 1,
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const unchanged = await detail(page, first.id);
  await checkbox(page, first).check();
  await page
    .getByRole("button", { name: "Edit selected", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Field to change").selectOption("add-tags");
  await dialog.getByLabel("New value").fill("new, NEW, Keep");
  await expect(dialog).toContainText("No change needed.");
  await expect(
    dialog.getByRole("button", { name: "Confirm edit 0" }),
  ).toBeDisabled();
  await dialog.getByLabel("Field to change").selectOption("remove-tags");
  await dialog.getByLabel("New value").fill("absent");
  await expect(dialog).toContainText("No change needed.");
  expect((await detail(page, first.id)).version).toBe(unchanged.version);
});

test("bulk metadata reconciles interrupted writes and preserves concurrent edits on retry", async ({
  page,
}) => {
  const prefix = `edit-retry-${randomUUID()}`;
  const interrupted = await create(page, `${prefix} interrupted`);
  const stale = await create(page, `${prefix} stale`);
  let writes = 0;
  await page.route(`**/api/actionables/${interrupted.id}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    writes++;
    expect((await route.fetch()).ok()).toBe(true);
    await route.abort("failed");
  });
  await page.goto(`/?q=${prefix}`);
  await page
    .getByRole("checkbox", { name: "Select all shown Actionables" })
    .check();
  await page
    .getByRole("button", { name: "Edit selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("New value").selectOption("High");
  await expect(dialog.getByRole("status")).toContainText("2 eligible");
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    await prisma.actionable.update({
      where: { id: stale.recordId },
      data: {
        description: "Concurrent description must survive",
        version: { increment: 1 },
      },
    });
  } finally {
    await prisma.$disconnect();
  }
  await dialog.getByRole("button", { name: "Confirm edit 2" }).click();
  await expect(dialog).toContainText(
    "Edit verified after the response was interrupted.",
  );
  await expect(dialog).toContainText("Review again before retrying.");
  await expect(dialog.getByRole("status")).toContainText("1 succeeded");
  expect(await detail(page, stale.id)).toMatchObject({
    description: "Concurrent description must survive",
    priority: "Medium",
  });
  await dialog.getByRole("button", { name: "Review remaining" }).click();
  await dialog.getByRole("button", { name: "Confirm edit 1" }).click();
  await expect(dialog.getByRole("status")).toContainText("2 succeeded");
  expect(writes).toBe(1);
  expect((await detail(page, interrupted.id)).version).toBe(
    interrupted.version + 1,
  );
  expect(await detail(page, stale.id)).toMatchObject({
    description: "Concurrent description must survive",
    priority: "High",
    version: stale.version + 2,
  });
});

test("@a11y bulk controls remain usable on desktop and mobile", async ({
  page,
}) => {
  const item = await create(page, `accessible-${randomUUID()}`);
  await page.goto(`/?q=${item.title}`);
  await checkbox(page, item).check();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const button of await page.locator(".bulk-toolbar button").all()) {
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    await page
      .getByRole("button", { name: "Dismiss selected", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("status")).toContainText("1 eligible");
    expect(
      (await new AxeBuilder({ page }).include(".bulk-dialog").analyze())
        .violations,
    ).toEqual([]);
    await dialog.getByLabel("Dismissal reason").fill("Reviewed with keyboard.");
    await dialog.getByLabel("Dismissal reason").focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      dialog.getByRole("button", { name: "Confirm dismiss 1" }),
    ).toBeFocused();
    await page.screenshot({
      path: `output/playwright/task528-dismiss-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Dismiss selected", exact: true }),
    ).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
