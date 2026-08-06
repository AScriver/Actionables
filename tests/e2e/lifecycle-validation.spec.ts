import { expect, test, type Page } from "@playwright/test";

async function createReadyCandidate(
  page: Page,
  title: string,
  finding = "Concrete finding.",
) {
  await page.goto("/");
  await page.getByRole("button", { name: "New actionable" }).click();
  await page.getByLabel("Title").fill(title);
  await page.locator("#finding").fill(finding);
  await page
    .locator("#description")
    .fill("Implement and preserve the bounded result.");
  await page.locator("#research").fill("Focused browser research is complete.");
  await page.locator("#validation").fill("Run the focused suite");
  await page.getByRole("button", { name: "Create actionable" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const inspector = page.getByRole("complementary", {
    name: "Selected actionable",
  });
  await inspector
    .getByRole("button", { name: "Researching", exact: true })
    .click();
  await inspector.getByRole("button", { name: "Confirm Researching" }).click();
  await expect(inspector.getByLabel(/^Researching\./)).toBeVisible();
}

test("lifecycle, append-only validation, safe Markdown, and sources persist through reload", async ({
  page,
  context,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("Playwright baseURL is required.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(baseURL).origin,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "New actionable" }).click();
  await page.getByLabel("Title").fill("T-004 browser lifecycle");
  await page
    .locator("#finding")
    .fill(
      "# Safe heading\n\n- keeps lists\n- keeps `inline code`\n\n" +
        "[unsafe](javascript:window.__markdownXss=true)\n\n" +
        "<script>window.__markdownXss=true</script>\n\n" +
        '<img src=x onerror="window.__markdownXss=true">',
    );
  await page
    .locator("#description")
    .fill("Use a code block:\n\n```powershell\npnpm test\n```");
  await page.locator("#resolution").fill("Initial browser resolution fixture.");
  await page.locator("#research").fill("Research **renders** safely.");
  await page.locator("#validation").fill("Run `pnpm test`");
  await page.getByRole("button", { name: "Add source reference" }).click();
  await page
    .locator(".source-edit-row")
    .nth(0)
    .getByLabel("Type")
    .selectOption("URL");
  await page.getByLabel("Source 1 locator").fill("javascript:alert('unsafe')");
  await page
    .getByLabel("Source 1 label")
    .fill("Unsafe source remains copy-only");
  await page.getByRole("button", { name: "Add source reference" }).click();
  await page
    .locator(".source-edit-row")
    .nth(1)
    .getByLabel("Type")
    .selectOption("URL");
  await page
    .getByLabel("Source 2 locator")
    .fill("https://example.test/evidence");
  await page.getByLabel("Source 2 label").fill("Safe web evidence");
  await page.getByRole("button", { name: "Create actionable" }).click();

  const inspector = page.getByRole("complementary", {
    name: "Selected actionable",
  });
  await expect(
    inspector.getByRole("heading", { name: "Safe heading" }),
  ).toBeVisible();
  await expect(
    inspector.locator("code").filter({ hasText: "inline code" }),
  ).toBeVisible();
  await expect(
    inspector.locator("pre").filter({ hasText: "pnpm test" }),
  ).toBeVisible();
  await expect(inspector.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(inspector.locator("script")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { __markdownXss?: boolean }).__markdownXss,
    ),
  ).toBeUndefined();

  const unsafeSource = inspector.locator(".user-source").filter({
    hasText: "Unsafe source remains copy-only",
  });
  await expect(
    unsafeSource.getByRole("link", { name: "Open source" }),
  ).toHaveCount(0);
  await unsafeSource
    .getByRole("button", { name: "Copy source locator" })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("javascript:alert('unsafe')");
  const safeSource = inspector
    .locator(".user-source")
    .filter({ hasText: "Safe web evidence" });
  await expect(safeSource.locator(".source-label")).toHaveText("user-added");
  await expect(
    safeSource.getByRole("link", { name: "Open source" }),
  ).toHaveAttribute("href", "https://example.test/evidence");

  await inspector
    .getByRole("button", { name: "Researching", exact: true })
    .click();
  await inspector.getByRole("button", { name: "Confirm Researching" }).click();
  await expect(inspector.getByLabel(/^Researching\./)).toBeVisible();
  await inspector.getByRole("button", { name: "Ready", exact: true }).click();
  await inspector.getByRole("button", { name: "Confirm Ready" }).click();
  await expect(inspector.getByLabel(/^Ready\./)).toBeVisible();
  await inspector
    .getByRole("button", { name: "In progress", exact: true })
    .click();
  await inspector.getByRole("button", { name: "Confirm In progress" }).click();
  await expect(inspector.getByLabel(/^In progress\./)).toBeVisible();

  await inspector.getByRole("tab", { name: "Validation" }).click();
  await inspector.getByRole("button", { name: "Record result" }).click();
  let validationForm = inspector.locator(".validation-form");
  await validationForm.getByLabel("Outcome").selectOption("Failed");
  await validationForm.getByLabel("Notes").fill("Focused suite failed.");
  await validationForm.getByLabel("Evidence").fill("Exit code `1`.");
  await validationForm.getByRole("button", { name: "Record result" }).click();
  await expect(
    inspector.locator(".validation-record").filter({ hasText: "Failed" }),
  ).toBeVisible();

  await inspector.getByRole("button", { name: "Done", exact: true }).click();
  await inspector.getByRole("button", { name: "Confirm Done" }).click();
  await expect(inspector.getByRole("alert")).toContainText(
    "Done requires a current Passed validation",
  );
  await inspector.getByRole("button", { name: "Cancel" }).click();
  consoleErrors.length = 0;

  await inspector.getByRole("button", { name: "Record result" }).click();
  validationForm = inspector.locator(".validation-form");
  await validationForm.getByLabel("Type").selectOption("Command");
  await validationForm.getByLabel("Outcome").selectOption("Passed");
  await validationForm.getByLabel("Notes").fill("Focused suite passed.");
  await validationForm.getByLabel("Evidence").fill("`pnpm test` exited `0`.");
  await validationForm.getByRole("button", { name: "Record result" }).click();
  await expect(
    inspector.getByText("Qualifying", { exact: true }),
  ).toBeVisible();

  await inspector.getByRole("button", { name: "Edit actionable" }).click();
  await page.locator("#resolution").fill("");
  await page.getByRole("button", { name: "Save changes" }).click();

  await inspector.getByRole("button", { name: "Done", exact: true }).click();
  await inspector.getByRole("button", { name: "Confirm Done" }).click();
  await expect(inspector.getByRole("alert")).toContainText(
    "Done requires Resolution content",
  );
  await inspector.getByRole("button", { name: "Cancel" }).click();
  consoleErrors.length = 0;

  await inspector.getByRole("button", { name: "Edit actionable" }).click();
  await page
    .locator("#resolution")
    .fill(
      "Completed the browser lifecycle and kept the existing validation policy.",
    );
  await page.getByRole("button", { name: "Save changes" }).click();
  await inspector.getByRole("tab", { name: "Resolution" }).click();
  await expect(
    inspector.getByText(
      "Describe the completed changes and important implementation decisions.",
    ),
  ).toBeVisible();
  await expect(
    inspector.getByText(
      "Completed the browser lifecycle and kept the existing validation policy.",
    ),
  ).toBeVisible();

  await inspector.getByRole("button", { name: "Done", exact: true }).click();
  await inspector.getByRole("button", { name: "Confirm Done" }).click();
  await expect(inspector.getByLabel(/^Done\./)).toBeVisible();
  const doneDeepLink = page.url();
  const lifecycleRow = page.getByRole("row", {
    name: /T-004 browser lifecycle/,
  });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(lifecycleRow).toBeVisible();
  await page.getByRole("button", { name: "Actionables", exact: true }).click();
  await expect(lifecycleRow).toHaveCount(0);
  await page.goto(doneDeepLink);
  await inspector.getByRole("tab", { name: "Activity" }).click();
  await expect(
    inspector.getByText("Completed with qualifying validation"),
  ).toBeVisible();
  await expect(
    inspector.getByText("Completion override used — not validated"),
  ).toHaveCount(0);

  const deepLink = page.url();
  await page.reload();
  await expect(page).toHaveURL(deepLink);
  await expect(inspector.getByLabel(/^Done\./)).toBeVisible();
  await inspector.getByRole("tab", { name: "Resolution" }).click();
  await expect(
    inspector.getByText(
      "Completed the browser lifecycle and kept the existing validation policy.",
    ),
  ).toBeVisible();
  await inspector.getByRole("button", { name: "Ready", exact: true }).click();
  await inspector
    .getByLabel("Reopening reason")
    .fill("A new requirement needs another pass.");
  await inspector.getByRole("button", { name: "Confirm Ready" }).click();
  await inspector.getByRole("tab", { name: "Validation" }).click();
  await expect(
    inspector.getByRole("heading", { name: "Activity" }),
  ).toHaveCount(0);
  await expect(inspector.locator(".validation-record")).toHaveCount(2);
  await inspector.getByRole("tab", { name: "Activity" }).click();
  await expect(inspector.getByText("Reopened Done to Ready")).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(lifecycleRow).toHaveCount(0);
  await page.getByRole("button", { name: "Actionables", exact: true }).click();
  await expect(lifecycleRow).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("a stale lifecycle action returns the current version without losing the pending reason", async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  await createReadyCandidate(firstPage, "Lifecycle conflict browser test");
  const deepLink = firstPage.url();
  await secondPage.goto(deepLink);

  const firstInspector = firstPage.getByRole("complementary", {
    name: "Selected actionable",
  });
  const secondInspector = secondPage.getByRole("complementary", {
    name: "Selected actionable",
  });
  await firstInspector
    .getByRole("button", { name: "Ready", exact: true })
    .click();
  await firstInspector.getByRole("button", { name: "Confirm Ready" }).click();
  await expect(firstInspector.getByLabel(/^Ready\./)).toBeVisible();

  await secondInspector
    .getByRole("button", { name: "Dismissed", exact: true })
    .click();
  await secondInspector
    .getByLabel("Dismissal reason")
    .fill("Keep this pending reason.");
  await secondInspector
    .getByRole("button", { name: "Confirm Dismissed" })
    .click();
  await expect(
    secondPage.getByText(/lifecycle action was stale/i),
  ).toBeAttached();
  await expect(secondInspector.getByLabel(/^Ready\./)).toBeVisible();
  await expect(secondInspector.getByLabel("Dismissal reason")).toHaveValue(
    "Keep this pending reason.",
  );

  await firstContext.close();
  await secondContext.close();
});

test("lifecycle controls remain usable at laptop and mobile sizes with keyboard access", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.setViewportSize({ width: 1586, height: 990 });
  await page.goto("/actionables/1");
  const inspector = page.getByRole("complementary", {
    name: "Selected actionable",
  });
  await expect(inspector.getByText("Server-permitted actions")).toBeVisible();
  await inspector.getByRole("tab", { name: "Validation" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    inspector.getByRole("heading", { name: "Validation records" }),
  ).toBeVisible();
  await inspector.getByRole("tab", { name: "Activity" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    inspector.getByRole("heading", { name: "Activity" }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/t004-actionables-desktop.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await expect(inspector.getByText("Server-permitted actions")).toBeVisible();
  await page.screenshot({
    path: "output/playwright/t004-actionables-laptop.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(inspector.getByText("Server-permitted actions")).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Findings", exact: true }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("tab", { name: "Validation" }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("tab", { name: "Relationships" }),
  ).toBeVisible();
  await expect(inspector.getByRole("tab", { name: "Activity" })).toBeVisible();
  await page.screenshot({
    path: "output/playwright/t004-actionables-mobile.png",
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});
