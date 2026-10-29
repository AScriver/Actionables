import { expect, test } from "@playwright/test";

test("keeps child handoffs available while only their parent is deferred", async ({
  page,
}) => {
  const fixture = (await (await page.request.get("/api/actionables/32")).json())
    .item;
  const created = await page.request.post("/api/actionables", {
    data: {
      title: "Deferred parent with active child",
      priority: "Medium",
      effort: "S",
      evidenceState: "Proposed",
      projectId: fixture.scope.projectId,
      repositoryId: fixture.scope.repositoryId,
      worktreeId: fixture.scope.worktreeId,
      finding: "Parent work is paused independently.",
      description: "Child work remains available.",
      research: [],
      validation: [],
      tags: [],
      userSources: [],
    },
  });
  expect(created.status()).toBe(201);
  let parent = (await created.json()).item;
  const children = await page.request.post(
    `/api/actionables/${parent.id}/subtasks`,
    {
      data: {
        version: parent.version,
        title: "Available child of deferred parent",
      },
    },
  );
  expect(children.ok()).toBe(true);
  parent = (await children.json()).item;
  const childId = parent.relationships.subtasks[0].child.id;
  const paused = await page.request.post(
    `/api/actionables/${parent.id}/defer`,
    { data: { version: parent.version } },
  );
  expect(paused.ok()).toBe(true);
  await page.goto(`/actionables/${parent.id}`);
  const controls = page.locator(".subtask-start-prompt");
  await expect(controls).toBeVisible();
  await controls
    .getByRole("combobox", { name: "First subtask" })
    .selectOption(String(childId));
  await controls
    .getByRole("button", { name: "Prepare subtask prompt" })
    .click();
  const link = controls.getByRole("link", {
    name: "Open subtask work in Codex",
  });
  await expect(link).toBeVisible();
  expect(
    new URL((await link.getAttribute("href"))!).searchParams.get("prompt"),
  ).toContain(`Claim task #${childId}`);
  await expect(
    page
      .locator(".agent-claim-panel")
      .getByRole("link", { name: "Open in Codex", exact: true }),
  ).toHaveCount(0);
});

test("defer, find after reload, and resume while preserving task status and content", async ({
  page,
}, testInfo) => {
  const title = "Manual deferral browser check";
  await page.goto("/actionables");
  await page.getByRole("button", { name: "New actionable" }).click();
  await page.getByLabel("Title").fill(title);
  await page.locator("#finding").fill("A finding to retain while deferred.");
  await page.locator("#description").fill("Return to this task later.");
  await page
    .locator("#research")
    .fill("Research retained across manual deferral.");
  await page.getByRole("button", { name: "Create actionable" }).click();
  const inspector = page.getByRole("complementary", {
    name: "Selected actionable",
  });
  await expect(inspector.getByRole("heading", { name: title })).toBeVisible();
  await inspector
    .getByRole("button", { name: "Defer actionable", exact: true })
    .click();
  await expect(
    inspector.getByText("Deferred until resumed.", { exact: true }),
  ).toBeVisible();
  await expect(inspector.getByLabel(/^Inbox\./)).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: title })).toHaveCount(0);
  await expect(
    inspector.getByRole("button", { name: "Researching", exact: true }),
  ).toHaveCount(0);
  await expect(
    inspector.getByRole("button", { name: "Start with Codex", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    inspector.getByText("Deferred until resumed.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByLabel("Deferred work").selectOption("all");
  await expect(page).toHaveURL(/deferred=all/);
  await expect(page.getByRole("row").filter({ hasText: title })).toBeVisible();
  await page.getByLabel("Deferred work").selectOption("deferred");
  await expect(page.getByRole("row").filter({ hasText: title })).toBeVisible();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("row").filter({ hasText: title }).click();
  await page.screenshot({
    path: testInfo.outputPath("manual-deferral.png"),
    fullPage: true,
  });
  await inspector
    .getByRole("button", { name: "Resume actionable", exact: true })
    .click();
  await expect(
    inspector.getByText("Deferred until resumed.", { exact: true }),
  ).toHaveCount(0);
  await expect(inspector.getByLabel(/^Inbox\./)).toBeVisible();
  await inspector.getByRole("tab", { name: "Research notes" }).click();
  await expect(
    inspector.getByText("Research retained across manual deferral.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "deferred: deferred" }).click();
  await expect(page.getByRole("row").filter({ hasText: title })).toBeVisible();
});
