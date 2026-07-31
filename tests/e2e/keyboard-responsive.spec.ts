import { expect, test } from "@playwright/test";

test("documented global shortcuts work and stay suppressed while editing or in dialogs", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("table", { name: "Actionable findings" }),
  ).toBeVisible();

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  await page.getByRole("button", { name: "Shortcuts" }).click();
  const help = page.locator("#shortcut-help");
  await expect(help).toContainText("/ search");
  await expect(help).toContainText("j/k move");
  await expect(help).toContainText("Enter open");
  await expect(help).toContainText("e edit");
  await expect(help).toContainText("c create");
  await page.getByRole("heading", { name: /Actionables/ }).click();

  await page.keyboard.press("/");
  const search = page.getByLabel("Search actionables");
  await expect(search).toBeFocused();
  await page.keyboard.type("ce/jk");
  await expect(search).toHaveValue("ce/jk");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await search.fill("");
  await search.press("Tab");

  await page.getByRole("heading", { name: /Actionables/ }).click();
  await page.keyboard.press("c");
  const createDialog = page.getByRole("dialog", { name: "New actionable" });
  await expect(createDialog).toBeVisible();
  const title = page.getByLabel("Title");
  await title.fill("Shortcut editing");
  await page.keyboard.type(" ce/jk");
  await expect(title).toHaveValue("Shortcut editing ce/jk");
  await page.keyboard.press("/");
  await expect(title).toHaveValue("Shortcut editing ce/jk/");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Close actionable form" }).click();
  await expect(createDialog).toHaveCount(0);

  await page.locator("body").evaluate((body) => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.setAttribute("aria-label", "Shortcut content editor fixture");
    body.append(editable);
    editable.focus();
  });
  const editable = page.getByLabel("Shortcut content editor fixture");
  await page.keyboard.type("ce/jk");
  await expect(editable).toHaveText("ce/jk");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await editable.evaluate((element) => element.remove());

  const rows = page.getByRole("row");
  const first = rows.nth(1);
  await first.focus();
  await first.press("Enter");
  const firstUrl = page.url();
  await page.keyboard.press("j");
  await expect(page).not.toHaveURL(firstUrl);
  await page.keyboard.press("k");
  await expect(page).toHaveURL(firstUrl);

  await page.getByRole("heading", { name: /Actionables/ }).click();
  await page.keyboard.press("e");
  await expect(
    page.getByRole("dialog", { name: "Edit actionable" }),
  ).toBeVisible();
  const editTitle = page.getByLabel("Title");
  const savedTitle = await editTitle.inputValue();
  await page.keyboard.press("/");
  await expect(editTitle).toHaveValue(`${savedTitle}/`);
});

test("finding title reveal ignores row whitespace and remains stable", async ({
  page,
}) => {
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects[0];
  const repository = project.repositories[0];
  const worktree = repository.worktrees[0];
  const shortTitleText = `T-298 hover target ${Date.now()}`;
  const createdResponse = await page.request.post("/api/actionables", {
    data: {
      title: shortTitleText,
      priority: "Low",
      effort: "S",
      evidenceState: "Confirmed",
      projectId: project.id,
      repositoryId: repository.id,
      worktreeId: worktree.id,
      finding: "Finding-title hover must exclude unused row whitespace.",
      description: "Exercise the finding-title hover target at desktop width.",
      research: [],
      validation: [],
      tags: [],
      userSources: [],
    },
  });
  expect(createdResponse.status()).toBe(201);
  const created = (await createdResponse.json()).item;

  await page.setViewportSize({ width: 1586, height: 990 });
  await page.goto(`/?q=${encodeURIComponent(shortTitleText)}`);
  const row = page.locator(`[data-actionable-id="${created.id}"]`);
  const title = row.locator(".finding-title");
  await expect(title).toBeVisible();
  await expect(row.locator(".row-tags")).toHaveCount(0);

  const geometry = await title.evaluate((element) => {
    const titleRect = element.getBoundingClientRect();
    const cellRect = element.parentElement!.getBoundingClientRect();
    const textRange = document.createRange();
    textRange.selectNodeContents(element);
    const textRect = textRange.getBoundingClientRect();
    return {
      cellRight: cellRect.right,
      textLeft: textRect.left,
      textRight: textRect.right,
      titleRight: titleRect.right,
      y: titleRect.top + titleRect.height / 2,
    };
  });
  expect(geometry.cellRight - geometry.textRight).toBeGreaterThan(100);
  expect(geometry.titleRight - geometry.textRight).toBeLessThanOrEqual(1);

  await page.mouse.move(
    Math.min(geometry.textRight + 100, geometry.cellRight - 10),
    geometry.y,
  );
  await page.waitForTimeout(300);
  expect(await title.evaluate((element) => element.matches(":hover"))).toBe(
    false,
  );
  await expect(title).toHaveCSS("position", "static");

  await page.mouse.move(geometry.textLeft + 20, geometry.y);
  await page.waitForTimeout(300);
  expect(await title.evaluate((element) => element.matches(":hover"))).toBe(
    true,
  );
  await expect(title).toHaveCSS("position", "absolute");

  const longTaggedTitle =
    "Route controller data access through the existing repository";
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto(`/?q=${encodeURIComponent(longTaggedTitle)}`);
  const taggedRow = page
    .getByRole("row", { name: new RegExp(longTaggedTitle) })
    .last();
  const taggedTitle = taggedRow.locator(".finding-title");
  await expect(taggedRow.locator(".row-tags")).toBeVisible();
  const truncation = await taggedTitle.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(truncation.clientWidth).toBeLessThan(truncation.scrollWidth);
  await expect(taggedTitle).toHaveCSS("text-overflow", "ellipsis");
  await taggedTitle.hover({ position: { x: 10, y: 8 } });
  await expect(taggedTitle).toHaveCSS("position", "absolute");
  await expect(taggedTitle).toHaveCSS("white-space", "normal");
  await expect(taggedTitle).toHaveCSS("text-overflow", "clip");
});

test("supported viewports and 200 percent equivalent reflow have no page overflow or obscured primary controls", async ({
  page,
}) => {
  const states = [
    { name: "desktop", width: 1586, height: 990 },
    { name: "laptop", width: 1280, height: 800 },
    { name: "intermediate", width: 900, height: 800 },
    { name: "mobile", width: 390, height: 844 },
    { name: "reflow-200-percent", width: 640, height: 480 },
  ];

  for (const state of states) {
    await page.setViewportSize({ width: state.width, height: state.height });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /Actionables/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New actionable" }),
    ).toBeVisible();
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(overflow.page, state.name).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({
      path: `output/playwright/t007-${state.name}.png`,
      fullPage: true,
    });
  }
});
