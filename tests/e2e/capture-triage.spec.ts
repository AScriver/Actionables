import { expect, test } from "@playwright/test";

test("invalid capture preserves entered values and exposes accessible field errors", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New actionable" }).click();

  await page.getByLabel("Priority").selectOption("High");
  await page.getByLabel("Description").fill("Keep this unsaved description.");
  await page.getByRole("button", { name: "Create actionable" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Check the highlighted fields",
  );
  await expect(page.locator("#title-error")).toHaveText("Enter a title.");
  await expect(page.getByLabel("Priority")).toHaveValue("High");
  await expect(page.getByLabel("Description")).toHaveValue(
    "Keep this unsaved description.",
  );
  await expect(page.getByLabel("Title")).toHaveAttribute(
    "aria-invalid",
    "true",
  );

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Discard your unsaved");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Close actionable form" }).click();
  await expect(
    page.getByRole("dialog", { name: "New actionable" }),
  ).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue(
    "Keep this unsaved description.",
  );
});

test("a stale save keeps the second draft recoverable across two browser contexts", async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();

  await firstPage.goto("/");
  await firstPage.getByRole("button", { name: "New actionable" }).click();
  await firstPage.getByLabel("Title").fill("Two-context conflict test");
  await firstPage.getByRole("button", { name: "Create actionable" }).click();
  await expect(firstPage).toHaveURL(/\/actionables\/\d+$/);
  const deepLink = firstPage.url();
  await expect(
    firstPage.getByRole("heading", { name: "Two-context conflict test" }),
  ).toBeVisible();

  await secondPage.goto(deepLink);
  await expect(
    secondPage.getByRole("heading", { name: "Two-context conflict test" }),
  ).toBeVisible();

  await firstPage.getByRole("button", { name: "Edit actionable" }).click();
  await secondPage.getByRole("button", { name: "Edit actionable" }).click();
  await firstPage.getByLabel("Title").fill("Saved from the first browser");
  await secondPage
    .getByLabel("Title")
    .fill("Recoverable draft from the second browser");

  await firstPage.getByRole("button", { name: "Save changes" }).click();
  await expect(
    firstPage.getByRole("heading", { name: "Saved from the first browser" }),
  ).toBeVisible();

  await secondPage.getByRole("button", { name: "Save changes" }).click();
  const conflict = secondPage.getByRole("alert");
  await expect(conflict).toContainText("Someone saved version");
  await expect(conflict).toContainText(
    "Your unsaved draft has not been changed or discarded",
  );
  await expect(secondPage.getByLabel("Title")).toHaveValue(
    "Recoverable draft from the second browser",
  );

  await secondPage
    .getByRole("button", { name: "Review current saved version" })
    .click();
  await expect(conflict).toContainText("Saved from the first browser");
  await secondPage
    .getByRole("button", { name: "Reload version and reapply draft" })
    .click();
  await expect(secondPage.getByLabel("Title")).toHaveValue(
    "Recoverable draft from the second browser",
  );
  await secondPage.getByRole("button", { name: "Save changes" }).click();
  await expect(
    secondPage.getByRole("heading", {
      name: "Recoverable draft from the second browser",
    }),
  ).toBeVisible();

  await secondPage.reload();
  await expect(secondPage).toHaveURL(deepLink);
  await expect(
    secondPage.getByRole("heading", {
      name: "Recoverable draft from the second browser",
    }),
  ).toBeVisible();

  await firstContext.close();
  await secondContext.close();
});

test("a mobile deep link opens detail and returns to the usable list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/actionables/1");

  await expect(
    page.getByRole("heading", {
      name: "Require authentication for private file downloads",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Findings", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("table", { name: "Actionable findings" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New actionable" }),
  ).toBeVisible();
});

test("triage to Ready persists the required fields and server-approved status", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New actionable" }).click();
  await page.getByLabel("Title").fill("Ready triage browser test");
  await page.getByRole("button", { name: "Create actionable" }).click();
  await expect(page).toHaveURL(/\/actionables\/\d+$/);

  await page.getByRole("button", { name: "Edit actionable" }).click();
  await page
    .locator("#finding")
    .fill("The browser flow has a concrete finding.");
  await page.locator("#description").fill("Persist the triaged actionable.");
  await page
    .locator("#research")
    .fill("The browser flow research is complete.");
  await page.locator("#validation").fill("Reload the stable deep link");
  await page.getByRole("button", { name: "Save changes" }).click();

  const inspector = page.getByRole("complementary", {
    name: "Selected actionable",
  });
  await inspector
    .getByRole("button", { name: "Researching", exact: true })
    .click();
  await inspector.getByRole("button", { name: "Confirm Researching" }).click();
  await expect(inspector.getByLabel(/^Researching\./)).toBeVisible();
  await inspector.getByRole("button", { name: "Ready", exact: true }).click();
  await inspector.getByRole("button", { name: "Confirm Ready" }).click();
  await expect(inspector.getByLabel(/^Ready\./)).toBeVisible();
  const deepLink = page.url();
  await page.reload();
  await expect(page).toHaveURL(deepLink);
  await expect(
    page.getByText("The browser flow has a concrete finding."),
  ).toBeVisible();
  await expect(
    page.getByText("The browser flow research is complete."),
  ).toBeVisible();
  await expect(inspector.getByLabel(/^Ready\./)).toBeVisible();
});
