import { expect, test } from "@playwright/test";

test("dashboard queues open the equivalent URL-backed actionable list", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByLabel("Actionable totals")).toContainText("total");
  await page.setViewportSize({ width: 1586, height: 990 });
  await page.screenshot({
    path: "output/playwright/t005-dashboard-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({
    path: "output/playwright/t005-dashboard-laptop.png",
    fullPage: true,
  });
  const queue = page.getByRole("button", { name: /Inbox requiring triage/ });
  await expect(queue).toBeVisible();
  await queue.click();
  await expect(page).toHaveURL(/status=Inbox/);
  await expect(
    page.getByRole("heading", { name: /Actionables/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /status: Inbox/ }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/t005-actionables-laptop.png",
    fullPage: true,
  });

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "output/playwright/t005-dashboard-mobile.png",
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});

test("filters, search, sort, selection, refresh, and history are URL-backed", async ({
  page,
}) => {
  await page.goto("/?priority=urgent&sort=random&q=Startup.cs");
  await expect(page).toHaveURL(/\/\?q=Startup\.cs$/);
  await expect(page.getByLabel("Search actionables")).toHaveValue("Startup.cs");
  await expect(
    page.getByRole("row", { name: /Protect generated and downloaded/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Filters/ }).click();
  const status = page.getByLabel("Status");
  await expect(status).toHaveValue("active");
  await status.selectOption("all");
  await expect(page).toHaveURL(/status=all/);
  await status.selectOption("active");
  await expect(page).not.toHaveURL(/status=/);
  await page.getByLabel("Priority").selectOption("Critical");
  await expect(page).toHaveURL(/priority=Critical/);

  const row = page.getByRole("row", {
    name: /Protect generated and downloaded/,
  });
  await row.press("Enter");
  await expect(page).toHaveURL(/\/actionables\/1\?/);
  const deepLink = page.url();
  await page.reload();
  await expect(page).toHaveURL(deepLink);
  await expect(
    page.getByRole("heading", {
      name: "Protect generated and downloaded files from anonymous static access",
    }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/priority=Critical/);
  await expect(page.getByLabel("Search actionables")).toHaveValue("Startup.cs");
  await page.goForward();
  await expect(page).toHaveURL(deepLink);
});

test("actionable archive and restore preserve status and support archived deep links", async ({
  page,
}) => {
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects[0];
  const repository = project.repositories[0];
  const worktree = repository.worktrees[0];
  const title = `T-005 archive browser ${Date.now()}`;
  const createdResponse = await page.request.post("/api/actionables", {
    data: {
      title,
      priority: "Low",
      effort: "S",
      evidenceState: "Confirmed",
      projectId: project.id,
      repositoryId: repository.id,
      worktreeId: worktree.id,
      finding: "Archive visibility must not change workflow state.",
      description: "Verify archive and restore through the daily shell.",
      research: [],
      validation: ["Confirm the status and deep link after restore"],
      tags: ["archive-e2e"],
      userSources: [],
    },
  });
  expect(createdResponse.status()).toBe(201);
  const created = (await createdResponse.json()).item;

  await page.goto(`/actionables/${created.id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const archiveButton = page.getByRole("button", {
    name: "Archive actionable",
  });
  await archiveButton.focus();
  await archiveButton.press("Enter");
  const archiveDialog = page.getByRole("dialog", { name: `Archive ${title}?` });
  await expect(archiveDialog).toContainText(
    "Workflow status and relationships are preserved",
  );
  await archiveDialog.press("Escape");
  await expect(archiveButton).toBeFocused();
  await archiveButton.press("Enter");
  await archiveDialog.getByRole("button", { name: `Archive ${title}` }).focus();
  await page.keyboard.press("Enter");
  const banner = page.getByText("Archived actionable").locator("..");
  await expect(banner).toContainText("Restore preserves workflow");
  await expect(page.getByLabel(/^Inbox\./)).toBeVisible();

  await page.goto("/archive");
  await expect(page.getByRole("heading", { name: /Archive/ })).toBeVisible();
  await page.getByRole("row", { name: new RegExp(title) }).press("Enter");
  await expect(page).toHaveURL(new RegExp(`/actionables/${created.id}`));
  await expect(page.getByText("Archived actionable")).toBeVisible();
  await page
    .locator(".archived-banner")
    .getByRole("button", { name: "Restore" })
    .click();
  const restoreDialog = page.getByRole("dialog", { name: `Restore ${title}?` });
  await restoreDialog.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(page.getByText("Archived actionable")).toHaveCount(0);
  await expect(page.getByLabel(/^Inbox\./)).toBeVisible();
});

test("loading and API failure states preserve a retry path", async ({
  page,
}) => {
  await page.route("**/api/actionables*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        type: "https://actionables.local/problems/test",
        title: "Fixture API failure",
        status: 500,
        code: "FIXTURE_FAILURE",
        requestId: "e2e-request-id",
      }),
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("cell").filter({ hasText: "Could not load actionables" }),
  ).toBeVisible();
  await expect(page.getByText(/e2e-request-id/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
