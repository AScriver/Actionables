import { expect, test } from "@playwright/test";

test("stale-work alerts expose all risk categories and open actionable detail", async ({
  page,
}) => {
  await page.route("**/api/dashboard", async (route) => {
    const response = await route.fetch();
    const dashboard = await response.json();
    const items = dashboard.queues
      .flatMap((queue: { items: unknown[] }) => queue.items)
      .filter(
        (item: { id: number }, index: number, all: Array<{ id: number }>) =>
          all.findIndex((candidate) => candidate.id === item.id) === index,
      )
      .slice(0, 4);

    dashboard.alerts = [
      {
        key: "expiring-claims",
        label: "Claims expiring soon",
        description: "Active agent leases with 10 minutes or less remaining.",
        tone: "warning",
        count: 1,
        items: [
          {
            actionable: items[0],
            detail: "agent:browser · expires 12:05 PM",
            dueAt: "2026-07-27T19:05:00.000Z",
          },
        ],
      },
      {
        key: "blocked-work",
        label: "Blocked work",
        description:
          "Tasks stopped by a manual blocker or unresolved prerequisite.",
        tone: "critical",
        count: 1,
        items: [
          {
            actionable: items[1],
            detail: "1 unresolved prerequisite",
            dueAt: null,
          },
        ],
      },
      {
        key: "missing-validation",
        label: "Missing validation",
        description: "In-progress work without a qualifying Passed result.",
        tone: "warning",
        count: 1,
        items: [
          {
            actionable: items[2],
            detail: "No qualifying Passed result since work started",
            dueAt: null,
          },
        ],
      },
      {
        key: "abandoned-sessions",
        label: "Abandoned sessions",
        description: "Expired agent leases that still need reconciliation.",
        tone: "critical",
        count: 1,
        items: [
          {
            actionable: items[3],
            detail: "agent:stale · expired 7/27/2026, 11:55:00 AM",
            dueAt: "2026-07-27T18:55:00.000Z",
          },
        ],
      },
    ];

    await route.fulfill({ response, json: dashboard });
  });

  await page.goto("/dashboard");
  const alerts = page.getByRole("region", { name: "Stale-work alerts" });
  await expect(alerts).toContainText("4 alerts");
  await expect(
    alerts.getByRole("heading", { name: "Claims expiring soon" }),
  ).toBeVisible();
  await expect(
    alerts.getByRole("heading", { name: "Blocked work" }),
  ).toBeVisible();
  await expect(
    alerts.getByRole("heading", { name: "Missing validation" }),
  ).toBeVisible();
  await expect(
    alerts.getByRole("heading", { name: "Abandoned sessions" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  const expiringTitle = await alerts
    .getByRole("button", { name: /agent:browser/ })
    .locator("span")
    .textContent();
  await alerts.getByRole("button", { name: /agent:browser/ }).click();
  await expect(page).toHaveURL(/\/actionables\/\d+/);
  await expect(
    page.getByRole("heading", { name: expiringTitle ?? "" }),
  ).toBeVisible();
});
