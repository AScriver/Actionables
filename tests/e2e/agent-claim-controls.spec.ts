import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type ClaimState = "unclaimed" | "active" | "expired";
const ACTIONABLE_ID = 32;

async function detailFixture(page: Page) {
  const response = await page.request.get(`/api/actionables/${ACTIONABLE_ID}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).item;
}

function withClaim(
  item: Record<string, unknown>,
  state: ClaimState,
  agentId = `agent:browser-${state}`,
) {
  const now = Date.now();
  return {
    ...item,
    agentClaim:
      state === "unclaimed"
        ? null
        : {
            agentId,
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
  let agentId: string | undefined;
  await page.route(`**/api/actionables/${ACTIONABLE_ID}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ item: withClaim(currentItem, state, agentId) }),
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
    setAgentId(next: string | undefined) {
      agentId = next;
    },
    item(next: ClaimState = state) {
      return withClaim(currentItem, next, agentId);
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

  const researchInstructions =
    "Treat the task detail returned by the Actionables MCP as the authoritative task record for the description, finding, existing research, sources, file references, relationships, and planned validation. Research this task before implementation, staying within its stated outcome and boundaries. Follow its named files and symbols, use targeted repository searches, inspect the directly relevant implementation path and only the callers, dependencies, conventions, and tests needed to understand it, and run focused read-only commands or reproductions to verify current behavior. Consult authoritative documentation only for technologies or contracts implicated by the task. Record concrete requirements, current behavior or root cause, relevant file and symbol references, verified assumptions, remaining questions, risks, and a focused validation plan in the Actionable. Do not investigate or propose adjacent cleanup. Keep the task Researching until the evidence is sufficient to implement its stated scope confidently; then move it to Ready, and only move it to In progress before editing.";
  const topLevelPrompt = `Use Actionables work item #${original.id}. Claim task #${original.id} — ${original.title} — and begin the Researching phase. ${researchInstructions}`;
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
  const subtaskPrompt = `Use Actionables work item #12. Claim task #${ACTIONABLE_ID} — Copy a direct-subtask prompt — and begin the Researching phase. ${researchInstructions}`;
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

test("Ready unclaimed tasks recommend claiming and continuing implementation", async ({
  page,
  context,
}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("Playwright baseURL is required.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(baseURL).origin,
  });
  const original = await detailFixture(page);
  await routeDetail(page, { ...original, status: "Ready" }, "unclaimed");
  await page.goto(`/actionables/${ACTIONABLE_ID}`);

  const readyPrompt = `Use Actionables work item #${original.id}. Claim task #${original.id} — ${original.title} — and continue from Ready. Use the task detail returned by the Actionables MCP as the authoritative source for the recorded finding, existing research, sources, file references, relationships, and planned validation. Confirm the scope, then move the task to In progress before editing. Implement the stated outcome, preserve existing user modifications, run the planned validation, record actual evidence, and move #${original.id} to Done only if it passes; otherwise hand off with the blocker.`;
  await expect(page.locator(".agent-start-prompt code")).toHaveText(
    readyPrompt,
  );
  await page
    .getByRole("button", { name: "Copy Codex start-task prompt" })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(readyPrompt);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".agent-start-prompt code")).toHaveText(
    readyPrompt,
  );
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
});

test("Ready claimed tasks recommend continuing without reclaiming", async ({
  page,
  context,
}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("Playwright baseURL is required.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(baseURL).origin,
  });
  const original = await detailFixture(page);
  await routeDetail(page, { ...original, status: "Ready" }, "active");
  await page.goto(`/actionables/${ACTIONABLE_ID}`);

  const readyPrompt = `Use Actionables work item #${original.id}. Continue task #${original.id} — ${original.title} — from Ready. Use the task detail returned by the Actionables MCP as the authoritative source for the recorded finding, existing research, sources, file references, relationships, and planned validation. Confirm the scope, then move the task to In progress before editing. Implement the stated outcome, preserve existing user modifications, run the planned validation, record actual evidence, and move #${original.id} to Done only if it passes; otherwise hand off with the blocker.`;
  await expect(page.locator(".agent-start-prompt code")).toHaveText(
    readyPrompt,
  );
  await page
    .getByRole("button", { name: "Copy Codex start-task prompt" })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(readyPrompt);
});

test("Codex claimants link to their thread while other claimants remain plain text", async ({
  page,
}) => {
  const original = await detailFixture(page);
  const fixture = await routeDetail(page, original, "active");
  fixture.setAgentId("codex:019fa5bb-765c-7011-9e41-164278c014c3");
  await page.goto(`/actionables/${ACTIONABLE_ID}`);

  const claimantLink = page.getByRole("link", {
    name: "codex://threads/019fa5bb-765c-7011-9e41-164278c014c3",
  });
  await expect(claimantLink).toHaveAttribute(
    "href",
    "codex://threads/019fa5bb-765c-7011-9e41-164278c014c3",
  );

  fixture.setAgentId("agent:legacy");
  await page.reload();
  const panel = page.locator(".agent-claim-panel");
  await expect(panel.getByText("agent:legacy", { exact: true })).toBeVisible();
  await expect(panel.getByRole("link")).toHaveCount(0);
});

test("claim panel covers unclaimed, active, expired, force release, conflict, error, desktop, and mobile states", async ({
  page,
}, testInfo) => {
  const original = await detailFixture(page);
  const fixture = await routeDetail(
    page,
    { ...original, status: "Inbox" },
    "unclaimed",
  );
  await page.goto(`/actionables/${ACTIONABLE_ID}`);
  const panel = page.locator(".agent-claim-panel");
  await expect(panel).toContainText("Unclaimed");
  await expect(
    panel.getByRole("button", { name: "Copy Codex start-task prompt" }),
  ).toBeVisible();

  fixture.setItem({ ...original, status: "Researching" });
  fixture.setState("active");
  await page.reload();
  await expect(panel).toContainText("Claimed");
  await expect(panel).toContainText("agent:browser-active");
  await expect(
    panel.getByRole("button", { name: "Copy Codex start-task prompt" }),
  ).toHaveCount(0);
  const activeReleaseButton = page.getByRole("button", {
    name: "Force release claim held by agent:browser-active",
  });
  await expect(activeReleaseButton).toBeVisible();
  await activeReleaseButton.click();
  const activeReleaseDialog = page.getByRole("dialog", {
    name: "Force release agent claim?",
  });
  await expect(activeReleaseDialog).toContainText(
    `Actionable #${ACTIONABLE_ID}`,
  );
  await expect(activeReleaseDialog).toContainText(original.title);
  await expect(activeReleaseDialog).toContainText("agent:browser-active");
  await expect(activeReleaseDialog).toContainText("Researching");
  await activeReleaseDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(activeReleaseButton).toBeFocused();

  fixture.setItem({ ...original, status: "Ready" });
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
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/force-release`,
    async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        version: original.version,
        agentId: "agent:browser-expired",
        claimedAt: expect.any(String),
      });
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
    name: "Release stale agent claim?",
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
  await expect(page.getByText("Agent claim force-released.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Agent claim", exact: true }),
  ).toBeFocused();
  await page.unroute(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/force-release`,
  );

  fixture.setState("expired");
  await page.reload();
  await page
    .getByRole("button", {
      name: "Release expired claim held by agent:browser-expired",
    })
    .click();
  await page.route(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/force-release`,
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
    name: "Release stale agent claim?",
  });
  await conflictDialog
    .getByRole("button", { name: "Release stale claim" })
    .click();
  const refreshedConflictDialog = page.getByRole("dialog", {
    name: "Force release agent claim?",
  });
  await expect(refreshedConflictDialog.getByRole("alert")).toContainText(
    "newer saved version",
  );
  await expect(
    refreshedConflictDialog.getByRole("button", {
      name: "Force release claim",
    }),
  ).toBeDisabled();
  await refreshedConflictDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toContainText("Claimed");
  await page.unroute(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/force-release`,
  );

  fixture.setState("expired");
  await page.reload();
  await page
    .getByRole("button", {
      name: "Release expired claim held by agent:browser-expired",
    })
    .click();
  await page.route(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/force-release`,
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
    name: "Release stale agent claim?",
  });
  await errorDialog
    .getByRole("button", { name: "Release stale claim" })
    .click();
  await expect(errorDialog.getByRole("alert")).toContainText(
    "Fixture claim release failure",
  );
  await page.unroute(
    `**/api/actionables/${ACTIONABLE_ID}/agent-claim/force-release`,
  );
  await errorDialog.getByRole("button", { name: "Cancel" }).click();

  fixture.setState("unclaimed");
  fixture.setItem({
    ...original,
    status: "Ready",
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

  fixture.setItem({ ...original, status: "Ready" });
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
    page.getByRole("dialog", { name: "Release stale agent claim?" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
