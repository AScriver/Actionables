import type {
  ActionableDetail,
  CreateRepositoryResponse,
  ScopeOptionsResponse,
} from "@actionables/contracts";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function createScopedFixture(
  request: APIRequestContext,
  name: string,
  localPath = `C:\\repos\\${name}`,
) {
  const repositoryResponse = await request.post("/api/repositories", {
    data: {
      projectMode: "new",
      projectName: `${name} project`,
      name: `${name} repository`,
      localPath,
    },
  });
  expect(repositoryResponse.ok()).toBeTruthy();
  const scope: CreateRepositoryResponse = await repositoryResponse.json();
  const actionableResponse = await request.post("/api/actionables", {
    data: {
      title: name,
      projectId: scope.projectId,
      repositoryId: scope.repositoryId,
      worktreeId: scope.worktreeId,
      priority: "Medium",
      effort: "S",
      evidenceState: "Confirmed",
      finding: "Exercise sidebar navigation with isolated fixture data.",
      description: "Verify scope filters and archival behavior.",
      research: [],
      validation: [],
      tags: ["sidebar-regression"],
      userSources: [],
    },
  });
  expect(actionableResponse.ok()).toBeTruthy();
  const { item }: { item: ActionableDetail } = await actionableResponse.json();
  return { scope, item };
}

test("repositories start collapsed and expand independently with selectable worktree children", async ({
  page,
}) => {
  const initialScopes: ScopeOptionsResponse = await (
    await page.request.get("/api/scopes")
  ).json();
  const project = initialScopes.projects.find(
    (candidate) => !candidate.archivedAt,
  )!;
  const siblingName = `Sidebar sibling ${Date.now()}`;
  const added = await page.request.post("/api/repositories", {
    data: {
      projectMode: "existing",
      projectId: project.id,
      name: siblingName,
      localPath: `C:\\repos\\SidebarSibling-${Date.now()}`,
    },
  });
  expect(added.ok()).toBeTruthy();
  const scopes: ScopeOptionsResponse = await (
    await page.request.get("/api/scopes")
  ).json();
  const repositories = scopes.projects
    .filter((candidate) => !candidate.archivedAt)
    .flatMap((candidate) => candidate.repositories)
    .filter((candidate) => !candidate.archivedAt);
  const repository = project.repositories.find(
    (candidate) => !candidate.archivedAt && candidate.worktrees.length > 0,
  )!;
  const worktree = repository.worktrees[0]!;

  await page.goto(`/dashboard?project=${project.id}`);
  const sidebar = page.getByRole("complementary", {
    name: "Repositories and worktrees",
  });
  const tree = sidebar.locator(".project-tree");
  await expect(tree.locator(".project-row")).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: /^Archive repository / }),
  ).toHaveCount(repositories.length);
  await expect(tree.locator(":scope > .repository-group")).toHaveCount(
    repositories.length,
  );
  await expect(
    tree.locator('.repository-expander[aria-expanded="false"]'),
  ).toHaveCount(repositories.length);
  const group = tree.locator(".repository-group").filter({
    has: page.getByRole("button", { name: repository.name, exact: true }),
  });
  await expect(group.locator(".worktree-row")).toHaveCount(
    repository.worktrees.length,
  );
  const repositoryButton = group.getByRole("button", {
    name: repository.name,
    exact: true,
  });
  await repositoryButton.click();
  await expect(repositoryButton).toHaveAttribute("aria-current", "page");
  let location = new URL(page.url());
  expect(location.pathname).toBe("/");
  expect(location.searchParams.get("project")).toBe(project.id);
  expect(location.searchParams.get("repository")).toBe(repository.id);
  expect(location.searchParams.has("worktree")).toBe(false);

  const worktreeButton = group
    .locator(".worktree-row")
    .filter({ hasText: worktree.name });
  await expect(worktreeButton).toBeHidden();
  const expander = group.locator(".repository-expander");
  await expect(expander).toHaveAccessibleName(
    `Expand repository ${repository.name}`,
  );
  await expander.press("Enter");
  await worktreeButton.click();
  await expect(worktreeButton).toHaveClass(/is-selected/);
  await expect(repositoryButton).not.toHaveAttribute("aria-current", "page");
  location = new URL(page.url());
  expect(location.searchParams.get("worktree")).toBe(worktree.id);
  const scopedUrl = page.url();

  const sibling = tree.locator(".repository-group").filter({
    has: page.getByRole("button", { name: siblingName, exact: true }),
  });
  await expect(sibling.locator(".worktree-row").first()).toBeHidden();
  await sibling.locator(".repository-expander").click();
  await expect(expander).toHaveAccessibleName(
    `Collapse repository ${repository.name}`,
  );
  await expander.press("Enter");
  await expect(expander).toHaveAttribute("aria-expanded", "false");
  await expect(worktreeButton).toBeHidden();
  await expect(page).toHaveURL(scopedUrl);
  await expect(sibling.locator(".worktree-row").first()).toBeVisible();
  await expander.press("Space");
  await expect(worktreeButton).toBeVisible();
  await expect(worktreeButton).toHaveClass(/is-selected/);
  await expect(page).toHaveURL(scopedUrl);

  await page.goBack();
  await expect(repositoryButton).toHaveAttribute("aria-current", "page");
  await expect(worktreeButton).not.toHaveClass(/is-selected/);
  await page.goForward();
  await expect(worktreeButton).toHaveClass(/is-selected/);
  await page.reload();
  await expect(worktreeButton).toHaveClass(/is-selected/);
  await expect(expander).toHaveAttribute("aria-expanded", "false");
  await expect(worktreeButton).toBeHidden();
  await expect(sibling.locator(".worktree-row").first()).toBeHidden();
  await page
    .getByRole("banner")
    .getByRole("button", { name: project.name, exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: project.name, exact: true }),
  ).toBeVisible();
});

test("archives and restores repositories from the sidebar while preserving their work and local files", async ({
  page,
}, testInfo) => {
  const localPath = testInfo.outputPath(`repository-${Date.now()}`);
  const localFile = resolve(localPath, "keep.txt");
  await mkdir(localPath, { recursive: true });
  await writeFile(localFile, "Keep local repository files.");
  const { scope, item } = await createScopedFixture(
    page.request,
    `Sidebar archive ${Date.now()}`,
    localPath,
  );
  const repository = scope.scopes.projects.find(
    (project) => project.id === scope.projectId,
  )!.repositories[0]!;
  const filters = new URLSearchParams({
    project: scope.projectId,
    repository: scope.repositoryId,
    worktree: scope.worktreeId,
    q: item.title,
    priority: "Medium",
  });
  await page.goto(`/?${filters}`);
  const sidebar = page.getByRole("complementary", {
    name: "Repositories and worktrees",
  });
  const archiveButton = sidebar.getByRole("button", {
    name: `Archive repository ${repository.name}`,
    exact: true,
  });
  await expect(archiveButton).toBeVisible();
  const impactUrl = `**/api/archive-impact/repository/${repository.id}`;
  await page.route(impactUrl, (route) =>
    route.fulfill({
      status: 503,
      json: {
        type: "https://actionables.local/problems/service_unavailable",
        title: "Repository impact is unavailable. Close and try again.",
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        requestId: "repository-impact-failure",
      },
    }),
  );
  await archiveButton.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: `Archive ${repository.name}?`,
  });
  const confirm = dialog.getByRole("button", {
    name: `Archive ${repository.name}`,
    exact: true,
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "Repository impact is unavailable",
  );
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(archiveButton).toBeFocused();
  await page.unroute(impactUrl);

  await archiveButton.press("Enter");
  await expect(dialog).toContainText("1 actionable will be effectively hidden");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(archiveButton).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`worktree=${scope.worktreeId}`));

  const archiveUrl = `**/api/scopes/repository/${repository.id}/archive`;
  await page.route(archiveUrl, (route) =>
    route.fulfill({
      status: 409,
      json: {
        type: "https://actionables.local/problems/version_conflict",
        title: "This scope record has a newer saved version.",
        status: 409,
        code: "VERSION_CONFLICT",
        requestId: "repository-archive-conflict",
      },
    }),
  );
  await archiveButton.click();
  await confirm.click();
  await expect(dialog.getByRole("alert")).toContainText("newer saved version");
  const unchanged = (
    await (await page.request.get(`/api/actionables/${item.id}`)).json()
  ).item;
  expect(unchanged.archiveState.isArchived).toBe(false);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(archiveButton).toBeFocused();
  await page.unroute(archiveUrl);

  await archiveButton.press("Enter");
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(archiveButton).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: repository.name, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Search actionables")).toBeFocused();
  filters.delete("repository");
  filters.delete("worktree");
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(
    Object.fromEntries(filters),
  );
  await page.reload();
  await expect(archiveButton).toHaveCount(0);
  const archivedScopes: ScopeOptionsResponse = await (
    await page.request.get("/api/scopes")
  ).json();
  const archivedRepository = archivedScopes.projects.find(
    (project) => project.id === scope.projectId,
  )!.repositories[0]!;
  expect(archivedRepository.archivedAt).not.toBeNull();
  expect(archivedRepository.worktrees[0]!.id).toBe(scope.worktreeId);
  expect(await readFile(localFile, "utf8")).toBe(
    "Keep local repository files.",
  );
  const inherited = (
    await (await page.request.get(`/api/actionables/${item.id}`)).json()
  ).item;
  expect(inherited.status).toBe(item.status);
  expect(inherited.archiveState).toMatchObject({
    isArchived: true,
    directlyArchived: false,
  });
  await sidebar.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.locator(`[data-actionable-id="${item.id}"]`)).toBeVisible();
  const restoreButton = sidebar.getByRole("button", {
    name: `Restore repository ${repository.name}`,
    exact: true,
  });
  await expect(restoreButton).toBeVisible();
  const archivedGroup = sidebar.locator(".repository-group").filter({
    has: page.getByRole("button", {
      name: `Restore repository ${repository.name}`,
      exact: true,
    }),
  });
  await archivedGroup.locator(".repository-select").click();
  await expect(page).toHaveURL(/\/archive\?/);
  expect(new URL(page.url()).searchParams.get("repository")).toBe(
    repository.id,
  );
  await archivedGroup.locator(".repository-expander").click();
  await archivedGroup.locator(".worktree-row").click();
  await expect(page).toHaveURL(/\/archive\?/);
  expect(new URL(page.url()).searchParams.get("worktree")).toBe(
    scope.worktreeId,
  );
  await page.screenshot({
    path: "output/playwright/repository-removal-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open project navigation" }).click();
  await restoreButton.press("Enter");
  const restoreDialog = page.getByRole("dialog", {
    name: `Restore ${repository.name}?`,
  });
  await expect(restoreDialog).toBeVisible();
  await expect(
    restoreDialog.getByRole("button", {
      name: `Restore ${repository.name}`,
      exact: true,
    }),
  ).toBeEnabled();
  await expect(restoreDialog).not.toContainText("will be effectively hidden");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "output/playwright/repository-removal-mobile.png",
    fullPage: true,
  });
  await restoreDialog
    .getByRole("button", { name: `Restore ${repository.name}`, exact: true })
    .click();
  await expect(restoreDialog).toHaveCount(0);
  const restoredItem = (
    await (await page.request.get(`/api/actionables/${item.id}`)).json()
  ).item;
  expect(restoredItem.status).toBe(item.status);
  expect(restoredItem.archiveState.isArchived).toBe(false);
  expect(await readFile(localFile, "utf8")).toBe(
    "Keep local repository files.",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?q=${encodeURIComponent(item.title)}`);
  await expect(archiveButton).toBeVisible();
  await expect(page.locator(`[data-actionable-id="${item.id}"]`)).toBeVisible();
});

test("Actionables clears every scope while preserving unrelated filters and allows rescoping", async ({
  page,
}) => {
  const prefix = `Sidebar filters ${Date.now()}`;
  const first = await createScopedFixture(page.request, `${prefix} first`);
  const second = await createScopedFixture(page.request, `${prefix} second`);
  const unrelated = {
    q: prefix,
    status: "Inbox",
    priority: "Low",
    exclude: "priority",
    effort: "S",
    tag: "sidebar-regression",
    sort: "title",
  };
  const scopedQuery = new URLSearchParams({
    ...unrelated,
    project: first.scope.projectId,
    repository: first.scope.repositoryId,
    worktree: first.scope.worktreeId,
  });
  await page.goto(`/?${scopedQuery}`);
  const firstRow = page.locator(`[data-actionable-id="${first.item.id}"]`);
  const secondRow = page.locator(`[data-actionable-id="${second.item.id}"]`);
  await expect(firstRow).toBeVisible();
  await expect(secondRow).toHaveCount(0);
  await page.getByRole("button", { name: "Actionables", exact: true }).click();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(
    unrelated,
  );
  await expect(firstRow).toBeVisible();
  await expect(secondRow).toBeVisible();
  await expect(page.getByLabel("Search actionables")).toHaveValue(prefix);
  await page.getByRole("button", { name: /Filters/ }).click();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("Inbox");
  await expect(page.getByLabel("Priority", { exact: true })).toHaveValue("Low");
  await expect(page.getByLabel("Effort", { exact: true })).toHaveValue("S");
  await expect(page.getByLabel("Tag", { exact: true })).toHaveValue(
    "sidebar-regression",
  );
  await expect(
    page
      .locator(".filter-field")
      .filter({ has: page.getByText("Priority", { exact: true }) })
      .getByRole("button", { name: "Exclude" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Filters/ }).click();

  await page
    .getByRole("banner")
    .getByRole("button", { name: "All projects", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", {
      name: `${prefix} second project`,
      exact: true,
    })
    .click();
  await expect(firstRow).toHaveCount(0);
  await expect(secondRow).toBeVisible();
  const group = page.locator(".repository-group").filter({
    has: page.getByRole("button", {
      name: `${prefix} second repository`,
      exact: true,
    }),
  });
  await group.locator(".repository-expander").click();
  await group.locator(".worktree-row").click();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
    ...unrelated,
    project: second.scope.projectId,
    repository: second.scope.repositoryId,
    worktree: second.scope.worktreeId,
  });
  await expect(secondRow).toBeVisible();
  await expect(firstRow).toHaveCount(0);

  await page.goto(`/dashboard?${scopedQuery}`);
  await page.getByRole("button", { name: "Actionables", exact: true }).click();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(
    unrelated,
  );
  await expect(firstRow).toBeVisible();
  await expect(secondRow).toBeVisible();

  scopedQuery.set("status", "Done");
  await page.goto(`/?${scopedQuery}`);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Actionables", exact: true }).click();
  const { status: _status, ...activeFilters } = unrelated;
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(
    activeFilters,
  );
  await expect(firstRow).toBeVisible();
  await expect(secondRow).toBeVisible();
});

test("Settings is a single keyboard-accessible shortcut in the sidebar status area", async ({
  page,
}) => {
  await page.goto("/?priority=High");
  const sidebar = page.locator(".sidebar");
  const footer = sidebar.locator(".sidebar-status");
  const settings = footer.getByRole("button", {
    name: "Settings",
    exact: true,
  });
  await expect(
    sidebar.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveCount(1);
  await expect(
    sidebar
      .locator(".primary-navigation")
      .getByRole("button", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await expect(footer).not.toContainText("Local API");
  await expect(footer).not.toContainText("Ready");
  await sidebar.getByRole("button", { name: /^All actionables/ }).focus();
  await page.keyboard.press("Tab");
  await expect(settings).toBeFocused();
  await settings.press("Enter");
  await expect(page).toHaveURL(/\/settings\?priority=High$/);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(settings).toHaveClass(/is-selected/);
  await page.screenshot({
    path: "output/playwright/sidebar-settings-desktop.png",
    fullPage: true,
  });

  await sidebar.getByRole("button", { name: "Collapse left sidebar" }).click();
  await expect(settings).toBeVisible();
  await sidebar.getByRole("button", { name: "Dashboard", exact: true }).click();
  await settings.press("Space");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/sidebar-settings-collapsed.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Open project navigation" })
    .click();
  await settings.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
});

test("legacy Data URLs open Actionables without import or export controls", async ({
  page,
}) => {
  await page.goto("/data?priority=High");
  await expect(
    page.getByRole("heading", { name: /^Actionables/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Actionable findings" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /^(Data|Export backup|Review selections|Commit reviewed import)$/,
    }),
  ).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?priority=High$/);
  await page.getByRole("button", { name: "Actionables", exact: true }).click();
  await expect(page).toHaveURL(/\/\?priority=High$/);
});
