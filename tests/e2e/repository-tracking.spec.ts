import { expect, test } from "@playwright/test";

test("adds an additional repository and makes it immediately selectable", async ({
  page,
}) => {
  const suffix = Date.now();
  const repositoryName = `Tracked browser repo ${suffix}`;
  const localPath = `C:\\repos\\TrackedBrowserRepo-${suffix}`;

  await page.goto("/");
  await page.getByRole("button", { name: "Add repository" }).click();

  const dialog = page.getByRole("dialog", { name: "Add repository" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Repository name").fill(repositoryName);
  await dialog.getByLabel("Local path").fill(localPath);
  await dialog
    .getByRole("button", { name: "Add repository", exact: true })
    .click();

  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: repositoryName, exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".project-tree").getByRole("button", { name: /^Default/ }),
  ).toBeVisible();
  await expect(page).toHaveURL(/repository=/);
  await expect(page).toHaveURL(/worktree=/);

  await page.getByRole("button", { name: "New actionable" }).click();
  const actionableDialog = page.getByRole("dialog", {
    name: "New actionable",
  });
  await expect(
    actionableDialog.getByLabel("Repository").locator("option:checked"),
  ).toHaveText(repositoryName);
  await expect(
    actionableDialog.getByLabel("Worktree").locator("option:checked"),
  ).toHaveText("Default");
  await expect(
    actionableDialog.getByLabel("Repository").getByRole("option", {
      name: repositoryName,
    }),
  ).toHaveCount(1);
  await actionableDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Add repository" }).click();
  const duplicateDialog = page.getByRole("dialog", { name: "Add repository" });
  await duplicateDialog.getByLabel("Repository name").fill(repositoryName);
  await duplicateDialog.getByLabel("Local path").fill(localPath);
  await duplicateDialog
    .getByRole("button", { name: "Add repository", exact: true })
    .click();

  await expect(duplicateDialog.getByRole("alert")).toContainText(
    "already tracked",
  );
  await expect(
    duplicateDialog.getByText(/repository with this name/i),
  ).toBeVisible();
  await expect(
    duplicateDialog.getByText(/path is already tracked/i),
  ).toBeVisible();
});

test("hides archived projects from the sidebar after refresh", async ({
  page,
}) => {
  const scopesResponse = await page.request.get("/api/scopes");
  expect(scopesResponse.ok()).toBeTruthy();
  const scopes = await scopesResponse.json();
  const project = scopes.projects.find(
    (candidate: { archivedAt: string | null }) => !candidate.archivedAt,
  );
  expect(project).toBeTruthy();
  if (!project) return;

  const sidebar = page.locator("aside.sidebar");

  try {
    await page.goto("/");
    await sidebar
      .getByRole("button", { name: `Archive project ${project.name}` })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Archive ${project.name}?`,
    });
    await dialog
      .getByRole("button", { name: `Archive ${project.name}` })
      .click();

    await expect(
      sidebar.getByRole("button", { name: project.name, exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", {
        name: `Restore project ${project.name}`,
      }),
    ).toHaveCount(0);

    await page.reload();

    await expect(
      sidebar.getByRole("button", { name: project.name, exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", {
        name: `Restore project ${project.name}`,
      }),
    ).toHaveCount(0);
  } finally {
    const currentScopes = await (await page.request.get("/api/scopes")).json();
    const currentProject = currentScopes.projects.find(
      (candidate: { id: string }) => candidate.id === project.id,
    );
    if (currentProject?.archivedAt) {
      const restored = await page.request.post(
        `/api/scopes/project/${project.id}/restore`,
        { data: { version: currentProject.version } },
      );
      expect(restored.ok()).toBeTruthy();
    }
  }
});
