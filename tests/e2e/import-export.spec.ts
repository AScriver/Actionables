import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("previews, authorizes, and explicitly commits portable JSON before linking affected work", async ({
  page,
  request,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const exportedResponse = await request.get("/api/data/export");
  expect(exportedResponse.ok()).toBe(true);
  const portable = await exportedResponse.json();
  portable.metadata.sourceName = "Playwright safe-update import";
  portable.actionables[0].description = `${portable.actionables[0].description}\n\nPlaywright verified portable reconciliation.`;
  const importPath = testInfo.outputPath("portable-import.json");
  await writeFile(importPath, `${JSON.stringify(portable, null, 2)}\n`, "utf8");

  await page.goto("/?q=portable-context");
  await page.getByRole("button", { name: "Data" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/data\?q=portable-context/);
  await page.getByRole("button", { name: "Actionables", exact: true }).click();
  await expect(page).toHaveURL(/\?q=portable-context/);
  await page.getByRole("button", { name: "Data" }).click();
  await expect(page.getByRole("heading", { name: "Data" })).toBeVisible();
  await expect(
    page.getByText(/Exports can contain technical paths/),
  ).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(importPath);
  await expect(page.getByRole("heading", { name: "2. Preview" })).toBeVisible();
  await expect(
    page.getByText("Schema version 1 is supported exactly."),
  ).toBeVisible();
  await expect(
    page.getByText("safe-update", { exact: true }).first(),
  ).toBeVisible();

  const beforeCommit = await request.get("/api/actionables/1");
  expect((await beforeCommit.json()).item.description).not.toContain(
    "Playwright verified portable reconciliation.",
  );

  const suggestionChecks = page.locator(".suggestion-list input");
  if (await suggestionChecks.count()) {
    await expect(suggestionChecks.first()).not.toBeChecked();
  }
  await page.getByRole("button", { name: "Review selections" }).click();
  const commitButton = page.getByRole("button", {
    name: "Commit reviewed import",
  });
  await expect(commitButton).toBeEnabled();
  await commitButton.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByText("Import committed")).toBeVisible();
  const afterCommit = await request.get("/api/actionables/1");
  expect((await afterCommit.json()).item.description).toContain(
    "Playwright verified portable reconciliation.",
  );
  const affected = page.getByRole("button", {
    name: portable.actionables[0].title,
  });
  await expect(affected).toBeVisible();
  await affected.click();
  await expect(page).toHaveURL(/\/actionables\/1/);

  await page.goto("/data");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^actionables-backup-\d{8}-\d{6}Z\.json$/,
  );
  expect(consoleErrors).toEqual([]);
});

test("keeps the Data area usable without horizontal page overflow on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/data");
  await expect(page.getByRole("heading", { name: "Data" })).toBeVisible();
  await expect(page.getByText("Choose portable JSON")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
});
