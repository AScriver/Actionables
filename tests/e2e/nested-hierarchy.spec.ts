import { expect, test } from "@playwright/test";

test("create, break down, link, move and detach nested subtrees", async ({
  page,
}) => {
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects[0];
  const repository = project.repositories[0];
  const worktree = repository.worktrees[0];
  const create = async (title: string) => {
    const response = await page.request.post("/api/actionables", {
      data: {
        title,
        priority: "Unset",
        effort: "Unknown",
        evidenceState: "Unclassified",
        projectId: project.id,
        repositoryId: repository.id,
        worktreeId: worktree.id,
        finding: "Nested hierarchy browser check",
        description: "Preserve nested relationships",
        research: [],
        validation: ["Verify nested relationships"],
        tags: [],
        userSources: [],
      },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).item;
  };
  const root = await create("Nested browser root");
  const existing = await create("Existing browser subtree");
  const existingChildResponse = await page.request.post(
    `/api/actionables/${existing.id}/subtasks`,
    {
      data: { version: existing.version, title: "Existing subtree child" },
    },
  );
  expect(existingChildResponse.ok()).toBe(true);
  const existingChild = (await existingChildResponse.json()).item.relationships
    .subtasks[0].child;
  await page.goto(`/actionables/${root.id}`);
  const inspector = page.getByRole("complementary", {
    name: "Selected actionable",
  });
  await inspector.getByRole("tab", { name: "Relationships" }).click();
  for (const title of [
    "Nested browser child",
    "Nested browser grandchild",
    "Nested browser great-grandchild",
  ]) {
    await page.getByLabel("New subtask name").fill(title);
    await page
      .getByLabel("New subtask name")
      .locator("..")
      .getByRole("button", { name: "Create", exact: true })
      .click();
    await inspector
      .getByRole("button", { name: new RegExp(` · ${title}$`) })
      .click();
    await inspector.getByRole("tab", { name: "Relationships" }).click();
  }
  await page.getByLabel("Task breakdown template").selectOption("research");
  await page.getByRole("button", { name: "Apply template" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Subtasks 3", exact: true }),
  ).toBeVisible();
  await page.reload();
  await inspector.getByRole("tab", { name: "Relationships" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Subtasks 3", exact: true }),
  ).toBeVisible();
  await inspector
    .locator(".relationship-parent")
    .getByRole("button", { name: /Nested browser grandchild/ })
    .click();
  await inspector.getByRole("tab", { name: "Relationships" }).click();
  await page.getByLabel("Existing subtask").selectOption(String(existing.id));
  await page
    .getByLabel("Existing subtask")
    .locator("..")
    .getByRole("button", { name: "Link", exact: true })
    .click();
  await inspector
    .getByRole("button", { name: / · Existing browser subtree$/ })
    .click();
  await inspector.getByRole("tab", { name: "Relationships" }).click();
  await expect(
    inspector.getByRole("button", { name: / · Existing subtree child$/ }),
  ).toBeVisible();
  await page.getByLabel("Replacement parent").selectOption(String(root.id));
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(
    inspector
      .locator(".relationship-parent")
      .getByRole("button", { name: /Nested browser root/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Detach", exact: true }).click();
  await expect(inspector.locator(".relationship-parent")).toHaveCount(0);
  const savedChild = await (
    await page.request.get(`/api/actionables/${existingChild.id}`)
  ).json();
  expect(savedChild.item.parentId).toBe(existing.id);
  await expect(
    inspector.getByRole("button", { name: / · Existing subtree child$/ }),
  ).toBeVisible();
});
