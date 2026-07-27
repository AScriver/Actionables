import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type ClaimState = "unclaimed" | "active" | "expired";
const ACTIONABLE_ID = 32;

async function detailFixture(page: Page) {
  const response = await page.request.get(`/api/actionables/${ACTIONABLE_ID}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).item;
}

function withClaim(item: Record<string, unknown>, state: ClaimState) {
  const now = Date.now();
  return {
    ...item,
    agentClaim:
      state === "unclaimed"
        ? null
        : {
            agentId: `agent:browser-${state}`,
            claimedAt: new Date(now - 45 * 60_000).toISOString(),
            renewedAt: new Date(now - 35 * 60_000).toISOString(),
            leaseExpiresAt: new Date(
              now + (state === "active" ? 30 : -1) * 60_000,
            ).toISOString(),
            state,
            isReleasable: state === "expired",
          },
  };
}

async function routeDetail(
  page: Page,
  item: Record<string, unknown>,
  initialState: ClaimState,
) {
  let state = initialState;
  let currentItem = item;
  await page.route(`**/api/actionables/${ACTIONABLE_ID}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ item: withClaim(currentItem, state) }),
      });
      return;
    }
    await route.continue();
  });
  return {
    setState(next: ClaimState) {
      state = next;
    },
    setItem(next: Record<string, unknown>) {
      currentItem = next;
    },
    item(next: ClaimState = state) {
      return withClaim(currentItem, next);
    },
  };
}

test("top-level and direct-subtask prompts copy the exact displayed suggestion", async ({
  page,
  context,
}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("Playwright baseURL is required.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(baseURL).origin,
  });
  const original = await detailFixture(page);
  const fixture = await routeDetail(page, original, "unclaimed");
  await page.goto(`/actionables/${ACTIONABLE_ID}`);

  const topLevelPrompt = `Use Actionables work item #${original.id}. Claim task #${original.id} — ${original.title} — and begin the Researching phase.`;
  await expect(page.locator(".agent-start-prompt code")).toHaveText(
    topLevelPrompt,
  );
  await page
    .getByRole("button", { name: "Copy Codex start-task prompt" })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(topLevelPrompt);

  const subtask = {
    ...original,
    parentId: 12,
    title: "Copy a direct-subtask prompt",
  };
  fixture.setItem(subtask);
  await page.reload();
  const subtaskPrompt = `Use Actionables work item #12. Claim task #${ACTIONABLE_ID} — Copy a direct-subtask prompt — and begin the Researching phase.`;
  await expect(page.locator(".agent-start-prompt code")).toHaveText(
    subtaskPrompt,
  );
  await page
    .getByRole("button", { name: "Copy Codex start-task prompt" })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(subtaskPrompt);
});

test("claim panel covers unclaimed, active, expired, release, conflict, error, desktop, and mobile states", async ({
  page,
}, testInfo) => {
  const original = await detailFixture(page);
  const fixture = await routeDetail(page, original, "unclaimed");
  await page.goto(`/actionables/${ACTIONABLE_ID}`);
  const panel = page.locator(".agent-claim-panel");
  await expect(panel).toContainText("Unclaimed");
  await expect(
    panel.getByRole("button", { name: "Copy Codex start-task prompt" }),
  ).toBeVisible();

  fixture.setState("active");
  await page.reload();
  await expect(panel).toContainText("Claimed");
  await expect(panel).toContainText("agent:browser-active");
  await expect(
    panel.getByRole("button", { name: "Copy Codex start-task prompt" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Release expired claim/ }),
  ).toHaveCount(0);

  fixture.setState("expired");
  await page.reload();
  await expect(panel).toContainText("Expired");
  await expect(
    panel.getByRole("button", { name: "Copy Codex start-task prompt" }),
  ).toHaveCount(0);
  const releaseButton = page.getByRole("button", {
    name: "Release expired claim held by agent:browser-expired",
  });
  await expect(releaseButton).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("agent-claim-expired-desktop.png"),
    fullPage: true,
  });

  await page.route(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/release-expired`,
    async (route) => {
      fixture.setState("unclaimed");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ item: fixture.item() }),
      });
    },
  );
  await releaseButton.click();
  const releaseDialog = page.getByRole("dialog", {
    name: "Release stale claim?",
  });
  await expect(releaseDialog).toBeVisible();
  await expect(
    releaseDialog.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    releaseDialog.getByRole("button", { name: "Release stale claim" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    releaseDialog.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await releaseDialog
    .getByRole("button", { name: "Release stale claim" })
    .click();
  await expect(releaseDialog).toHaveCount(0);
  await expect(panel).toContainText("Unclaimed");
  await expect(
    page.getByRole("heading", { name: "Agent claim", exact: true }),
  ).toBeFocused();
  await page.unroute(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/release-expired`,
  );

  fixture.setState("expired");
  await page.reload();
  await page
    .getByRole("button", {
      name: "Release expired claim held by agent:browser-expired",
    })
    .click();
  await page.route(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/release-expired`,
    async (route) => {
      fixture.setState("active");
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          type: "https://actionables.local/problems/version_conflict",
          title: "This actionable has a newer saved version.",
          status: 409,
          code: "VERSION_CONFLICT",
          requestId: "claim-conflict-fixture",
          current: fixture.item(),
        }),
      });
    },
  );
  const conflictDialog = page.getByRole("dialog", {
    name: "Release stale claim?",
  });
  await conflictDialog
    .getByRole("button", { name: "Release stale claim" })
    .click();
  await expect(conflictDialog.getByRole("alert")).toContainText(
    "newer saved version",
  );
  await expect(
    conflictDialog.getByRole("button", { name: "Release stale claim" }),
  ).toBeDisabled();
  await conflictDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toContainText("Claimed");
  await page.unroute(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/release-expired`,
  );

  fixture.setState("expired");
  await page.reload();
  await page
    .getByRole("button", {
      name: "Release expired claim held by agent:browser-expired",
    })
    .click();
  await page.route(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/release-expired`,
    async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          type: "https://actionables.local/problems/test",
          title: "Fixture claim release failure",
          status: 500,
          code: "FIXTURE_FAILURE",
          requestId: "claim-release-fixture",
        }),
      });
    },
  );
  const errorDialog = page.getByRole("dialog", {
    name: "Release stale claim?",
  });
  await errorDialog
    .getByRole("button", { name: "Release stale claim" })
    .click();
  await expect(errorDialog.getByRole("alert")).toContainText(
    "Fixture claim release failure",
  );
  await page.unroute(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/release-expired`,
  );
  await errorDialog.getByRole("button", { name: "Cancel" }).click();

  fixture.setState("unclaimed");
  fixture.setItem({
    ...original,
    archiveState: {
      ...original.archiveState,
      isArchived: true,
      directlyArchived: true,
    },
  });
  await page.reload();
  await expect(panel).toContainText(
    "Restore this Actionable before starting agent work.",
  );
  await expect(
    panel.getByRole("button", { name: "Copy Codex start-task prompt" }),
  ).toHaveCount(0);

  fixture.setItem({ ...original, status: "Done" });
  await page.reload();
  await expect(panel).toContainText(
    "Reopen this Done Actionable before starting agent work.",
  );
  await expect(
    panel.getByRole("button", { name: "Copy Codex start-task prompt" }),
  ).toHaveCount(0);

  fixture.setItem(original);
  for (const viewport of [
    { name: "mobile", width: 390, height: 844 },
    { name: "reflow", width: 640, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/actionables/${ACTIONABLE_ID}`);
    await expect(
      page.getByRole("heading", { name: "Agent claim", exact: true }),
    ).toBeVisible();
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(overflow.page, viewport.name).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({
      path: testInfo.outputPath(`agent-claim-${viewport.name}.png`),
      fullPage: true,
    });
  }
});

test("@a11y expired claim panel and confirmation dialog pass axe", async ({
  page,
}) => {
  const original = await detailFixture(page);
  await routeDetail(page, original, "expired");
  await page.goto(`/actionables/${ACTIONABLE_ID}`);
  await expect(
    page.getByRole("button", {
      name: "Release expired claim held by agent:browser-expired",
    }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("button", {
      name: "Release expired claim held by agent:browser-expired",
    })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Release stale claim?" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
