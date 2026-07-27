import { expect, test } from "@playwright/test";

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
    await expect(page.getByRole("status")).toContainText(
      "Helper agent prompts saved.",
    );

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
    await expect(page.getByRole("status")).toContainText(
      "Helper agent prompts saved.",
    );
  }
});
