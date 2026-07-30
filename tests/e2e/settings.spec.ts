import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const missingIntegration = {
  mcp: {
    apiOrigin: "http://127.0.0.1:4274",
    endpoint: "http://127.0.0.1:4274/mcp",
    enabled: false,
    bearerTokenEnvironmentVariable: "ACTIONABLES_MCP_TOKEN",
  },
  mcpServer: {
    id: "mcpServer",
    label: "Actionables MCP server",
    description: "Registers the effective Actionables MCP endpoint.",
    targetPath: "C:\\TestUser\\.codex\\config.toml",
    state: "missing",
    installed: false,
  },
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
  await expect(page.getByText("http://127.0.0.1:4274/mcp")).toBeVisible();
  await expect(
    page.getByText(/Create a strong local token.*ACTIONABLES_MCP_TOKEN/),
  ).toBeVisible();
  await expect(page.getByText(/Restart Codex after registering/)).toBeVisible();
  await expect(
    page.getByText("Generate and save a token on Windows"),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "Not now" }).click();
  await page.goto("/settings");
  await expect(
    page.getByRole("region", { name: "Actionables agent integration" }),
  ).toBeVisible();
  const noteToggle = page.getByRole("checkbox", {
    name: "Enable Groom notes with local Codex",
  });
  await expect(noteToggle).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Enable Relationship auditor" }),
  ).toBeChecked();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  try {
    await noteToggle.uncheck();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(noteToggle).not.toBeChecked();
    await expect(
      page.locator(".settings-form footer").getByRole("status"),
    ).toContainText("Helper agent settings saved.");
  } finally {
    if (!(await noteToggle.isChecked())) {
      await noteToggle.check();
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(
        page.locator(".settings-form footer").getByRole("status"),
      ).toContainText("Helper agent settings saved.");
    }
  }
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
  await expect(dialog.getByRole("checkbox")).toHaveCount(3);
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

test("first-run setup sends conflicting MCP registration to manual review", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.removeItem("actionables-agent-integration-setup-dismissed-v1"),
  );
  await page.route("**/api/settings/agent-integration", (route) =>
    route.fulfill({
      json: {
        ...missingIntegration,
        mcpServer: {
          ...missingIntegration.mcpServer,
          state: "modified",
        },
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
    }),
  );

  await page.reload();
  const dialog = page.getByRole("dialog", {
    name: "Set up Actionables for Codex",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: /Actionables MCP server/ }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("checkbox", { name: /Actionables MCP server/ }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: /Actionables agent instructions/ }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: /Actionables agent instructions/ }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("checkbox", { name: /Actionables workflow skill/ }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: /Actionables workflow skill/ }),
  ).toBeDisabled();
  await expect(dialog.getByText("Manual review required")).toBeVisible();
  await expect(dialog.getByText("Installed", { exact: true })).toHaveCount(2);
  await expect(
    dialog.getByRole("button", { name: "Install selected" }),
  ).toBeDisabled();
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
  expect(payload).toEqual({
    mcpServer: false,
    agentInstructions: false,
    skill: true,
  });
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toBeHidden();
});

test("settings can install all missing components later", async ({ page }) => {
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
            mcp: missingIntegration.mcp,
            mcpServer: {
              ...missingIntegration.mcpServer,
              state: "installed",
              installed: true,
            },
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
              component: "mcpServer",
              outcome: "installed",
              message:
                "The Actionables MCP server was registered. Restart Codex.",
            },
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
  await integration
    .getByRole("button", { name: "Install all available" })
    .click();
  expect(payload).toEqual({
    mcpServer: true,
    agentInstructions: true,
    skill: true,
  });
  await expect(integration.getByText("Installed", { exact: true })).toHaveCount(
    3,
  );
  await expect(integration.getByRole("status")).toContainText(
    "Agent instructions were appended",
  );
});

test("edits and persists helper agent settings on the settings page", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveClass(/is-selected/);

  const noteSettings = page.getByRole("region", {
    name: "Groom notes with local Codex",
  });
  const relationshipSettings = page.getByRole("region", {
    name: "Relationship auditor",
  });
  const coordinationSettings = page.getByRole("region", {
    name: "Agent coordination",
  });
  const localCodexSettings = page.getByRole("region", {
    name: "Local Codex runtime",
  });
  const leaseMinutes = coordinationSettings.getByLabel(
    "Default claim lease (minutes)",
  );
  const warningMinutes = coordinationSettings.getByLabel(
    "Expiry warning window (minutes)",
  );
  const timeoutSeconds = localCodexSettings.getByLabel(
    "Request timeout (seconds)",
  );
  const resetTimeout = localCodexSettings.getByRole("button", {
    name: "Reset to default",
  });
  const notePrompt = noteSettings.getByLabel("Prompt instructions");
  const relationshipPrompt = relationshipSettings.getByLabel(
    "Prompt instructions",
  );
  const noteModel = noteSettings.getByLabel("Model", { exact: true });
  const noteReasoning = noteSettings.getByLabel("Reasoning level", {
    exact: true,
  });
  const relationshipModel = relationshipSettings.getByLabel("Model", {
    exact: true,
  });
  const relationshipReasoning = relationshipSettings.getByLabel(
    "Reasoning level",
    { exact: true },
  );
  await expect(notePrompt).not.toHaveValue("");
  await expect(relationshipPrompt).not.toHaveValue("");
  await expect(leaseMinutes).toHaveValue("30");
  await expect(warningMinutes).toHaveValue("10");
  await expect(timeoutSeconds).toHaveValue("");
  await expect(timeoutSeconds).toHaveAttribute("placeholder", "120");
  await expect(resetTimeout).toBeDisabled();
  await expect(
    localCodexSettings.getByText(/Effective timeout:/),
  ).toContainText("120 seconds (default)");
  await expect(noteModel).toHaveValue("");
  await expect(noteReasoning).toHaveValue("");
  await expect(relationshipModel).toHaveValue("");
  await expect(relationshipReasoning).toHaveValue("");
  await expect(noteSettings.getByText(/Effective model:/)).toContainText(
    "gpt-5.6-terra",
  );
  await expect(
    relationshipSettings.getByText(/Effective model:/),
  ).toContainText("gpt-5.6-terra");
  await expect(noteSettings.getByText(/Effective reasoning:/)).toContainText(
    "selected model default",
  );
  await expect(
    relationshipSettings.getByText(/Effective reasoning:/),
  ).toContainText("selected model default");
  const originalNotePrompt = await notePrompt.inputValue();
  const originalRelationshipPrompt = await relationshipPrompt.inputValue();
  const savedNotePrompt = `${originalNotePrompt}\n\nKeep section headings concise.`;
  const savedRelationshipPrompt = `${originalRelationshipPrompt}\n\nPrefer recommendations with direct ID evidence.`;

  try {
    await leaseMinutes.fill("20");
    await warningMinutes.fill("20");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(warningMinutes).toHaveAttribute("aria-invalid", "true");
    await expect(
      page.locator("#agentClaimExpiryWarningMinutes-error"),
    ).toHaveText("The expiry warning must be shorter than the claim lease.");
    await expect(page.getByRole("alert")).toContainText(
      "Check the agent coordination settings.",
    );

    await leaseMinutes.fill("45");
    await warningMinutes.fill("12");
    await timeoutSeconds.fill("29");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(timeoutSeconds).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#localCodexTimeoutSeconds-error")).toHaveText(
      "Enter a whole number from 30 through 900, or reset to the default.",
    );
    await expect(page.getByRole("alert")).toContainText(
      "Check the Local Codex runtime settings.",
    );

    await timeoutSeconds.fill("300");
    await noteModel.selectOption("gpt-5.6-sol");
    await noteReasoning.selectOption("high");
    await relationshipModel.selectOption("gpt-5.6-luna");
    await relationshipReasoning.selectOption("xhigh");
    await notePrompt.fill(savedNotePrompt);
    await relationshipPrompt.fill(savedRelationshipPrompt);
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(
      page.locator(".settings-form footer").getByRole("status"),
    ).toContainText("Helper agent settings saved.");

    await page.reload();
    await expect(leaseMinutes).toHaveValue("45");
    await expect(warningMinutes).toHaveValue("12");
    await expect(timeoutSeconds).toHaveValue("300");
    await expect(
      localCodexSettings.getByText(/Effective timeout:/),
    ).toContainText("300 seconds (override)");
    await expect(noteModel).toHaveValue("gpt-5.6-sol");
    await expect(noteReasoning).toHaveValue("high");
    await expect(relationshipModel).toHaveValue("gpt-5.6-luna");
    await expect(relationshipReasoning).toHaveValue("xhigh");
    await expect(noteSettings.getByText(/Effective model:/)).toContainText(
      "gpt-5.6-sol",
    );
    await expect(
      relationshipSettings.getByText(/Effective model:/),
    ).toContainText("gpt-5.6-luna");
    await expect(noteSettings.getByText(/Effective reasoning:/)).toContainText(
      "high",
    );
    await expect(
      relationshipSettings.getByText(/Effective reasoning:/),
    ).toContainText("xhigh");
    await expect(notePrompt).toHaveValue(savedNotePrompt);
    await expect(relationshipPrompt).toHaveValue(savedRelationshipPrompt);

    await resetTimeout.click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(
      page.locator(".settings-form footer").getByRole("status"),
    ).toContainText("Helper agent settings saved.");
    await page.reload();
    await expect(timeoutSeconds).toHaveValue("");
    await expect(
      localCodexSettings.getByText(/Effective timeout:/),
    ).toContainText("120 seconds (default)");
    await expect(resetTimeout).toBeDisabled();

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
    await leaseMinutes.fill("30");
    await warningMinutes.fill("10");
    await timeoutSeconds.fill("");
    await noteModel.selectOption("");
    await noteReasoning.selectOption("");
    await relationshipModel.selectOption("");
    await relationshipReasoning.selectOption("");
    await notePrompt.fill(originalNotePrompt);
    await relationshipPrompt.fill(originalRelationshipPrompt);
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(
      page.locator(".settings-form footer").getByRole("status"),
    ).toContainText("Helper agent settings saved.");
    await page.reload();
    await expect(leaseMinutes).toHaveValue("30");
    await expect(warningMinutes).toHaveValue("10");
    await expect(noteModel).toHaveValue("");
    await expect(noteReasoning).toHaveValue("");
    await expect(relationshipModel).toHaveValue("");
    await expect(relationshipReasoning).toHaveValue("");
    await expect(noteSettings.getByText(/Effective model:/)).toContainText(
      "gpt-5.6-terra",
    );
    await expect(
      relationshipSettings.getByText(/Effective model:/),
    ).toContainText("gpt-5.6-terra");
  }
});

test("disables helper actions independently and allows re-enabling", async ({
  page,
}) => {
  await page.goto("/settings");
  const noteToggle = page.getByRole("checkbox", {
    name: "Enable Groom notes with local Codex",
  });
  const relationshipToggle = page.getByRole("checkbox", {
    name: "Enable Relationship auditor",
  });
  const notePrompt = page.getByLabel("Prompt instructions").first();
  const relationshipPrompt = page.getByLabel("Prompt instructions").last();
  await expect(notePrompt).not.toHaveValue("");
  await expect(relationshipPrompt).not.toHaveValue("");
  const originalNotePrompt = await notePrompt.inputValue();
  const originalRelationshipPrompt = await relationshipPrompt.inputValue();

  try {
    await noteToggle.uncheck();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(
      page.locator(".settings-form footer").getByRole("status"),
    ).toContainText("Helper agent settings saved.");

    await page.reload();
    await expect(noteToggle).not.toBeChecked();
    await expect(relationshipToggle).toBeChecked();
    await expect(notePrompt).toHaveValue(originalNotePrompt);
    await expect(relationshipPrompt).toHaveValue(originalRelationshipPrompt);

    await page.goto("/actionables/1");
    const inspector = page.getByRole("complementary", {
      name: "Selected actionable",
    });
    await inspector.getByRole("tab", { name: "Research notes" }).click();
    await expect(
      inspector.getByRole("heading", {
        name: "Groom notes with local Codex",
      }),
    ).toHaveCount(0);
    await inspector.getByRole("tab", { name: "Relationships" }).click();
    await expect(
      inspector.getByRole("heading", { name: "Relationship auditor" }),
    ).toBeVisible();

    await page.goto("/settings");
    await noteToggle.check();
    await relationshipToggle.uncheck();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(
      page.locator(".settings-form footer").getByRole("status"),
    ).toContainText("Helper agent settings saved.");

    await page.reload();
    await expect(noteToggle).toBeChecked();
    await expect(relationshipToggle).not.toBeChecked();
    await expect(notePrompt).toHaveValue(originalNotePrompt);
    await expect(relationshipPrompt).toHaveValue(originalRelationshipPrompt);

    await page.goto("/actionables/1");
    await inspector.getByRole("tab", { name: "Research notes" }).click();
    await expect(
      inspector.getByRole("heading", {
        name: "Groom notes with local Codex",
      }),
    ).toBeVisible();
    await inspector.getByRole("tab", { name: "Relationships" }).click();
    await expect(
      inspector.getByRole("heading", { name: "Relationship auditor" }),
    ).toHaveCount(0);
  } finally {
    await page.goto("/settings");
    const needsRestore =
      !(await noteToggle.isChecked()) ||
      !(await relationshipToggle.isChecked());
    if (needsRestore) {
      await noteToggle.check();
      await relationshipToggle.check();
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(
        page.locator(".settings-form footer").getByRole("status"),
      ).toContainText("Helper agent settings saved.");
    }
  }
});
