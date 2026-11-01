import type { AnalysisResult } from "@fot/core/schema";
import { test as base, expect, type Page } from "@playwright/test";

interface Demo {
  id: string;
  title: string;
  touchpoints: "Origin exchange wallets" | "Arrival exchange wallets";
}

const DEMOS: readonly Demo[] = [
  {
    id: "d1-source-of-funds-ethereum",
    title: "Source of funds on Ethereum",
    touchpoints: "Origin exchange wallets",
  },
  {
    id: "d2-exchange-arrivals-tron",
    title: "Where withdrawn funds went on TRON",
    touchpoints: "Arrival exchange wallets",
  },
  {
    id: "d3-linked-wallets",
    title: "Linked wallets across two payments",
    touchpoints: "Origin exchange wallets",
  },
];
// d2 has the fewest recorded requests (77), so the palette and phone tests use it.
const FAST_DEMO = "Where withdrawn funds went on TRON";

/** Fails the test on any console error or uncaught page error. */
const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, provide) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.text()}`);
      });
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      await provide(errors);
      expect(errors, "browser console errors").toEqual([]);
    },
    { auto: true },
  ],
});

/** Starts a demo from its Home card and waits until the run completes; returns the run id. */
async function runDemo(page: Page, title: string): Promise<string> {
  await page.goto("/");
  await expect(page.getByText("DEMO-ONLY INSTANCE")).toBeVisible();
  const card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) });
  await card.getByRole("button", { name: "Run demo" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("main").getByText("Completed", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  const runId = new URL(page.url()).pathname.split("/").at(-1);
  if (!runId) throw new Error(`No run id in ${page.url()}`);
  return runId;
}

for (const demo of DEMOS) {
  test(`${demo.id}: graph, tabs and report`, async ({ page }) => {
    const runId = await runDemo(page, demo.title);

    const graph = page.getByRole("region", { name: "Transfer graph" });
    await expect(graph.getByText(/^\d+ addresses · \d+ pairs$/)).toBeVisible();
    await expect(graph.locator(".react-flow__node").first()).toBeVisible();

    await page.getByRole("tab", { name: /^Exposure/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "By category" })).toBeVisible();

    await page.getByRole("tab", { name: /^Linked wallets/ }).click();
    await expect(
      page.getByRole("tabpanel").getByText(/^(Seeds: .+|No linked wallets found)$/),
    ).toBeVisible();

    await page.getByRole("tab", { name: /^Exchange touchpoints/ }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: demo.touchpoints, exact: true }),
    ).toBeVisible();

    await page.getByRole("tab", { name: /^Flags/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: /^\d+ flags?$/ })).toBeVisible();

    await page.getByRole("link", { name: "Open report" }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/report$`));
    const report = page.locator("article.report");
    await expect(
      report.getByRole("heading", { level: 1, name: demo.title, exact: true }),
    ).toBeVisible();
    await expect(report.getByText(/^EVIDENCE REPORT · /)).toBeVisible();
    await expect(report.getByRole("heading", { level: 2, name: "9. Limitations" })).toBeVisible();
  });
}

test("⌘K finds an address of the open run", async ({ page }) => {
  const runId = await runDemo(page, FAST_DEMO);
  const response = await page.request.get(`/api/runs/${runId}`);
  expect(response.ok()).toBe(true);
  const run: { result: AnalysisResult | null } = await response.json();
  const address = run.result?.graph.addresses[0]?.address;
  if (!address) throw new Error("The finished run has no addresses");

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder("Search address, tx or label").fill(address);
  const short = new RegExp(`${address.slice(0, 6)}…${address.slice(-4)}`, "i");
  await expect(palette.getByRole("option").filter({ hasText: short }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  const panel = page
    .locator("aside")
    .filter({ has: page.getByRole("button", { name: "Close detail panel" }) });
  await expect(panel.getByText(address, { exact: true })).toBeVisible();
});

test.describe("phone (390 px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Path view, full graph and the ☰ menu", async ({ page }) => {
    await runDemo(page, FAST_DEMO);
    await expect(page.getByRole("tab", { name: /^Path/ })).toHaveAttribute("aria-selected", "true");
    const path = page.getByRole("region", { name: "Highest-value path" });
    await expect(path.getByRole("listitem").first()).toBeVisible();

    await page.getByRole("button", { name: "Full graph" }).click();
    const fullGraph = page.getByRole("dialog", { name: "Full graph" });
    await expect(fullGraph.getByRole("region", { name: "Transfer graph" })).toBeVisible();
    await fullGraph.getByRole("button", { name: "× Close", exact: true }).click();
    await expect(fullGraph).toBeHidden();

    await page.getByRole("button", { name: "Open menu" }).click();
    const menu = page.locator("#mobile-navigation");
    await expect(
      menu
        .getByRole("navigation", { name: "Mobile navigation" })
        .getByRole("link", { name: "History" }),
    ).toBeVisible();
    await menu.getByRole("button", { name: "Search", exact: true }).click();
    const palette = page.getByRole("dialog", { name: "Search" });
    await expect(palette).toBeVisible();
    await palette.getByRole("button", { name: "Cancel" }).click();
    await expect(palette).toBeHidden();
  });
});
