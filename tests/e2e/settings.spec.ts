import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const missingIntegration = {
  agentInstructions: {
    id: "agentInstructions",
    label: "Actionables agent instructions",
    description: "Adds Actionables task-coordination guidance.",
    targetPath: "C:\\TestUser\\.codex\\AGENTS.md",
    state: "missing",
    installed: false,
  },
  skill: {
    id: "skill",
    label: "Actionables workflow skill",
    description: "Installs the Actionables workflow.",
    targetPath: "C:\\TestUser\\.agents\\skills\\actionables-workflow\\SKILL.md",
    state: "missing",
    installed: false,
  },
} as const;

test("@a11y agent integration onboarding and settings pass axe", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.removeItem("actionables-agent-integration-setup-dismissed-v1"),
  );
  await page.route("**/api/settings/agent-integration", (route) =>
    route.fulfill({ json: missingIntegration }),
  );
  await page.reload();

  await expect(
    page.getByRole("dialog", { name: "Set up Actionables for Codex" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "Not now" }).click();
  await page.goto("/settings");
  await expect(
    page.getByRole("region", { name: "Actionables agent integration" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("first-run setup is unchecked and can be skipped without installing", async ({
  page,
}) => {
  let installRequests = 0;
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.removeItem("actionables-agent-integration-setup-dismissed-v1"),
  );
  await page.route("**/api/settings/agent-integration", (route) =>
    route.fulfill({ json: missingIntegration }),
  );
  await page.route(
    "**/api/settings/agent-integration/install",
    async (route) => {
      installRequests += 1;
      await route.abort();
    },
  );

  await page.reload();
  const dialog = page.getByRole("dialog", {
    name: "Set up Actionables for Codex",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await expect(dialog.getByRole("checkbox").first()).not.toBeChecked();
  await expect(dialog.getByRole("checkbox").last()).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Install selected" }),
  ).toBeDisabled();

  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toBeHidden();
  expect(installRequests).toBe(0);

  await page.reload();
  await expect(dialog).toBeHidden();
});

test("first-run setup installs only the selected component", async ({
  page,
}) => {
  let payload: unknown;
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.removeItem("actionables-agent-integration-setup-dismissed-v1"),
  );
  await page.route("**/api/settings/agent-integration", (route) =>
    route.fulfill({ json: missingIntegration }),
  );
  await page.route(
    "**/api/settings/agent-integration/install",
    async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        json: {
          settings: {
            ...missingIntegration,
            skill: {
              ...missingIntegration.skill,
              state: "installed",
              installed: true,
            },
          },
          results: [
            {
              component: "skill",
              outcome: "installed",
              message: "The Actionables workflow skill was installed.",
            },
          ],
        },
      });
    },
  );

  await page.reload();
  const dialog = page.getByRole("dialog", {
    name: "Set up Actionables for Codex",
  });
  await dialog
    .getByRole("checkbox", { name: /Actionables workflow skill/ })
    .check();
  await dialog.getByRole("button", { name: "Install selected" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "workflow skill was installed",
  );
  expect(payload).toEqual({ agentInstructions: false, skill: true });
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toBeHidden();
});

test("settings can install both missing components later", async ({ page }) => {
  let payload: unknown;
  await page.route("**/api/settings/agent-integration", (route) =>
    route.fulfill({ json: missingIntegration }),
  );
  await page.route(
    "**/api/settings/agent-integration/install",
    async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        json: {
          settings: {
            agentInstructions: {
              ...missingIntegration.agentInstructions,
              state: "installed",
              installed: true,
            },
            skill: {
              ...missingIntegration.skill,
              state: "installed",
              installed: true,
            },
          },
          results: [
            {
              component: "agentInstructions",
              outcome: "installed",
              message: "Agent instructions were appended.",
            },
            {
              component: "skill",
              outcome: "installed",
              message: "The workflow skill was installed.",
            },
          ],
        },
      });
    },
  );

  await page.goto("/settings");
  const integration = page.getByRole("region", {
    name: "Actionables agent integration",
  });
  await expect(integration).toBeVisible();
  await integration.getByRole("button", { name: "Install both" }).click();
  expect(payload).toEqual({ agentInstructions: true, skill: true });
  await expect(integration.getByText("Installed", { exact: true })).toHaveCount(
    2,
  );
  await expect(integration.getByRole("status")).toContainText(
    "Agent instructions were appended",
  );
});

test("edits and persists helper agent prompts on the settings page", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toHaveClass(
    /is-selected/,
  );

  const notePrompt = page.getByLabel("Prompt instructions").first();
  const relationshipPrompt = page.getByLabel("Prompt instructions").last();
  const originalNotePrompt = await notePrompt.inputValue();
  const originalRelationshipPrompt = await relationshipPrompt.inputValue();
  const savedNotePrompt = `${originalNotePrompt}\n\nKeep section headings concise.`;
  const savedRelationshipPrompt = `${originalRelationshipPrompt}\n\nPrefer recommendations with direct ID evidence.`;

  try {
    await notePrompt.fill(savedNotePrompt);
    await relationshipPrompt.fill(savedRelationshipPrompt);
    await page.getByRole("button", { name: "Save prompts" }).click();
    await expect(
      page.locator(".settings-form footer").getByRole("status"),
    ).toContainText("Helper agent prompts saved.");

    await page.reload();
    await expect(notePrompt).toHaveValue(savedNotePrompt);
    await expect(relationshipPrompt).toHaveValue(savedRelationshipPrompt);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/settings");
    await page
      .getByLabel("Prompt instructions")
      .first()
      .fill(originalNotePrompt);
    await page
      .getByLabel("Prompt instructions")
      .last()
      .fill(originalRelationshipPrompt);
    await page.getByRole("button", { name: "Save prompts" }).click();
    await expect(
      page.locator(".settings-form footer").getByRole("status"),
    ).toContainText("Helper agent prompts saved.");
  }
});
