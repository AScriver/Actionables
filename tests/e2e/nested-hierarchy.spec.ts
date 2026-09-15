import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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

test("browse four levels with independent expansion, keyboard access and flat filtered results", async ({
  page,
}, testInfo) => {
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects[0];
  const repository = project.repositories[0];
  const worktree = repository.worktrees[0];
  const response = await page.request.post("/api/actionables", {
    data: {
      title: "Browse nested root",
      priority: "Unset",
      effort: "Unknown",
      evidenceState: "Unclassified",
      projectId: project.id,
      repositoryId: repository.id,
      worktreeId: worktree.id,
      finding: "Browse nested hierarchy",
      description: "Navigate each level",
      research: [],
      validation: [],
      tags: [],
      userSources: [],
    },
  });
  expect(response.status()).toBe(201);
  const root = (await response.json()).item;
  const nodes: Array<{ id: number; title: string }> = [root];
  for (const [parentIndex, title] of [
    [0, "child"],
    [1, "grandchild"],
    [2, "great-grandchild"],
    [0, "sibling"],
  ] as const) {
    const parent = (
      await (
        await page.request.get(`/api/actionables/${nodes[parentIndex].id}`)
      ).json()
    ).item;
    const saved = await page.request.post(
      `/api/actionables/${parent.id}/subtasks`,
      {
        data: { version: parent.version, title: `Browse nested ${title}` },
      },
    );
    expect(saved.ok()).toBe(true);
    nodes.push((await saved.json()).item.relationships.subtasks.at(-1).child);
  }
  const row = (index: number) =>
    page.locator(`[data-actionable-id="${nodes[index].id}"]`);
  await page.goto("/");
  await expect(row(0)).toBeVisible();
  await expect(row(1)).toHaveCount(0);
  for (const index of [0, 1, 2]) {
    const before = page.url();
    const expand = page.getByRole("button", {
      name: `Expand subtasks for ${nodes[index].title}`,
      exact: true,
    });
    await expand.press("Enter");
    await expect(expand).toHaveCount(0);
    await expect(page).toHaveURL(before);
    await expect(
      page.getByRole("button", {
        name: `Collapse subtasks for ${nodes[index].title}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-expanded", "true");
  }
  await expect(
    page
      .locator(".finding-row .finding-title")
      .filter({ hasText: "Browse nested" }),
  ).toHaveText(nodes.map((node) => node.title));
  const positions = [];
  for (const index of [0, 1, 2, 3])
    positions.push(
      (await row(index).locator(".finding-title").boundingBox())!.x,
    );
  expect(
    positions.every((x, index) => index === 0 || x > positions[index - 1]),
  ).toBe(true);
  await row(0).press("Enter");
  await page.keyboard.press("j");
  await expect(page).toHaveURL(new RegExp(`/actionables/${nodes[1].id}$`));
  await page.keyboard.press("j");
  await expect(page).toHaveURL(new RegExp(`/actionables/${nodes[2].id}$`));
  await page
    .getByRole("button", {
      name: `Collapse subtasks for ${nodes[1].title}`,
      exact: true,
    })
    .press("Space");
  await expect(row(2)).toHaveCount(0);
  await expect(row(3)).toHaveCount(0);
  await expect(row(4)).toBeVisible();
  await page
    .getByRole("button", {
      name: `Expand subtasks for ${nodes[1].title}`,
      exact: true,
    })
    .click();
  await expect(row(3)).toBeVisible();
  await page.reload();
  await expect(row(3)).toBeVisible();
  for (const index of [2, 3]) {
    await page.getByLabel("Search actionables").fill(nodes[index].title);
    await expect(row(index)).toBeVisible();
    await expect(row(0)).toHaveCount(0);
    await expect(row(index)).toHaveCount(1);
    await expect(row(index).locator(".row-expander")).toHaveCount(0);
  }
  await page.goto("/?parent=subtasks");
  await expect(row(0)).toHaveCount(0);
  await expect(row(3)).toBeVisible();
  await page.goto("/");
  await expect(row(3)).toBeVisible();
  const current = (
    await (await page.request.get(`/api/actionables/${nodes[2].id}`)).json()
  ).item;
  expect(
    (
      await page.request.post(`/api/actionables/${current.id}/archive`, {
        data: { version: current.version },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(row(2)).toHaveCount(0);
  await expect(row(3)).toBeVisible();
  await page.goto("/archive");
  await expect(row(2)).toBeVisible();
  await expect(row(0)).toHaveCount(0);
  await expect(row(2).locator(".row-expander")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("nested-filtered-mobile.png"),
    fullPage: true,
  });
});
