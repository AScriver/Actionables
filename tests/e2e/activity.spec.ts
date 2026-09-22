import AxeBuilder from "@axe-core/playwright";
import type { ActionableDetail } from "@actionables/contracts";
import { expect, test } from "@playwright/test";

test("subtask activity toggles, attributes and links the full hierarchy without changing history", async ({
  page,
}, testInfo) => {
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects[0];
  const repository = project.repositories[0];
  const worktree = repository.worktrees[0];
  const tasks: ActionableDetail[] = [];
  const detail = async (id: number): Promise<ActionableDetail> => {
    const response = await page.request.get(`/api/actionables/${id}`);
    expect(response.ok()).toBe(true);
    return (await response.json()).item;
  };
  for (const title of [
    "Activity parent",
    "Activity child one",
    "Activity child two",
    "Activity nested child",
    "Activity unrelated",
  ]) {
    const response = await page.request.post("/api/actionables", {
      data: {
        title,
        priority: "Medium",
        effort: "S",
        evidenceState: "Confirmed",
        projectId: project.id,
        repositoryId: repository.id,
        worktreeId: worktree.id,
        finding: "Activity visibility check",
        description: "Show existing subtask activity",
        research: [],
        validation: ["Verify combined activity"],
        tags: [],
        userSources: [],
      },
    });
    expect(response.status()).toBe(201);
    tasks.push((await response.json()).item);
  }
  const [parent, child, sibling, nested, unrelated] = tasks;
  for (const [parentTask, childTask] of [
    [parent, child],
    [parent, sibling],
    [child, nested],
  ]) {
    const response = await page.request.put(
      `/api/actionables/${childTask.id}/parent`,
      {
        data: {
          version: (await detail(childTask.id)).version,
          parentId: parentTask.id,
          parentVersion: (await detail(parentTask.id)).version,
        },
      },
    );
    expect(response.ok()).toBe(true);
  }
  const before = await Promise.all(tasks.map((task) => detail(task.id)));
  const expected = before
    .slice(0, 4)
    .flatMap((task) => task.activity)
    .sort((left, right) => {
      const time = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
      if (time) return time;
      return left.id < right.id ? -1 : 1;
    });
  await page.goto(`/actionables/${parent.id}`);
  const inspector = page.getByRole("complementary", {
    name: "Selected actionable",
  });
  const tab = inspector.getByRole("tab", { name: "Activity", exact: true });
  await tab.click();
  const checkbox = inspector.getByRole("checkbox", {
    name: "Show subtask activity",
  });
  const rows = inspector.locator(".activity-timeline article");
  await expect(checkbox).not.toBeChecked();
  await expect(rows.locator("strong")).toHaveText(
    before[0].activity.map((event) => event.summary),
  );
  for (let index = 0; index < 3; index++) {
    await checkbox.focus();
    await checkbox.press("Space");
    await expect(checkbox).toBeChecked();
    await expect(rows.locator("strong")).toHaveText(
      expected.map((event) => event.summary),
    );
    await expect(rows.locator("time")).toHaveCount(expected.length);
    for (const task of before.slice(1, 4)) {
      const links = rows.getByRole("link", {
        name: `#${task.id} · ${task.title}`,
        exact: true,
      });
      await expect(links).toHaveCount(task.activity.length);
      await expect(links.first()).toHaveAttribute(
        "href",
        `/actionables/${task.id}`,
      );
    }
    await expect(rows.getByText(unrelated.title, { exact: true })).toHaveCount(
      0,
    );
    await expect(tab).toHaveAttribute("aria-selected", "true");
    if (index < 2) {
      await checkbox.press("Space");
      await expect(checkbox).not.toBeChecked();
      await expect(rows.locator("strong")).toHaveText(
        before[0].activity.map((event) => event.summary),
      );
    }
  }
  expect(await Promise.all(tasks.map((task) => detail(task.id)))).toEqual(
    before,
  );
  expect(
    (await new AxeBuilder({ page }).include(".inspector").analyze()).violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("combined-activity-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await tab.click();
  await checkbox.check();
  await expect(rows).toHaveCount(expected.length);
  await expect(checkbox).toBeVisible();
  expect(
    await inspector.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("combined-activity-mobile.png"),
    fullPage: true,
  });
  await rows
    .getByRole("link", { name: `#${nested.id} · ${nested.title}`, exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/actionables/${nested.id}$`));
  await expect(
    inspector.getByRole("heading", { name: nested.title, exact: true }),
  ).toBeVisible();
  await tab.click();
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await expect(rows).toHaveCount(before[3].activity.length);
});

test("activity filter exposes loading and retry and handles an empty combined feed", async ({
  page,
}) => {
  const { items } = await (await page.request.get("/api/actionables")).json();
  const id = items[0].id;
  let respond: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    respond = resolve;
  });
  let fail = true;
  await page.route(
    `**/api/actionables/${id}?includeSubtaskActivity=true`,
    async (route) => {
      await held;
      if (fail) {
        await route.fulfill({ status: 500, json: { title: "Unavailable" } });
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { item: { ...body.item, activity: [] } },
      });
    },
  );
  await page.goto(`/actionables/${id}`);
  const inspector = page.getByRole("complementary", {
    name: "Selected actionable",
  });
  await inspector.getByRole("tab", { name: "Activity", exact: true }).click();
  const checkbox = inspector.getByRole("checkbox", {
    name: "Show subtask activity",
  });
  const rows = inspector.locator(".activity-timeline article");
  const parentCount = await rows.count();
  await checkbox.check();
  await expect(inspector.getByRole("status")).toHaveText(
    "Loading subtask activity…",
  );
  await checkbox.uncheck();
  await expect(inspector.getByRole("status")).toHaveCount(0);
  await checkbox.check();
  respond();
  await expect(inspector.getByRole("alert")).toContainText(
    "Could not load subtask activity. Showing parent activity only.",
  );
  await expect(rows).toHaveCount(parentCount);
  fail = false;
  await inspector.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    inspector.getByText("No activity has been recorded.", { exact: true }),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);
  await checkbox.uncheck();
  await expect(rows).toHaveCount(parentCount);
});
