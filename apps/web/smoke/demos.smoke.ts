import type { AnalysisResult } from "@fot/core/schema";
import { test as base, expect, type Locator, type Page } from "@playwright/test";

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

/** Text of every element whose content is wider than its box, i.e. runs into its neighbour. */
function overflowing(cells: Locator): Promise<string[]> {
  return cells.evaluateAll((elements) =>
    elements
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.textContent ?? ""),
  );
}

/** Exactly one `h1`, and no heading more than one level below the heading before it. */
async function expectHeadingOutline(page: Page, where: string): Promise<void> {
  const levels = await page
    .locator("h1, h2, h3, h4, h5, h6")
    .evaluateAll((headings) =>
      headings
        .filter((heading) => heading.getClientRects().length > 0)
        .map((heading) => Number(heading.tagName.slice(1))),
    );
  expect(
    levels.filter((level) => level === 1),
    `${where}: h1 elements`,
  ).toHaveLength(1);
  const skips = levels.flatMap((level, i) => {
    const previous = levels[i - 1];
    return previous !== undefined && level > previous + 1 ? [`h${previous} → h${level}`] : [];
  });
  expect(skips, `${where}: skipped heading levels`).toEqual([]);
}

/** Visible controls under 44 × 44 px, except links inside running text (WCAG 2.5.8 inline). */
function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const controls = document.querySelectorAll(
      'a[href], button, input, select, textarea, [role="button"], [role="tab"], [tabindex="0"]',
    );
    return [...controls].flatMap((control) => {
      if (control.closest("[inert]") || getComputedStyle(control).visibility === "hidden")
        return [];
      const box = control.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || (box.width >= 44 && box.height >= 44)) return [];
      const text = control.textContent?.trim() ?? "";
      const parent = control.parentElement;
      if (control.tagName === "A" && parent?.tagName === "P" && parent.textContent?.trim() !== text)
        return [];
      const name = control.getAttribute("aria-label") ?? (text || control.tagName);
      return [`${name.slice(0, 48)} (${Math.round(box.width)}×${Math.round(box.height)})`];
    });
  });
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
    const touchpointCells = page.getByRole("tabpanel").locator("section section > div, li > div");
    expect(await overflowing(touchpointCells), "touchpoint cells wider than their column").toEqual(
      [],
    );

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
    await page.setViewportSize({ width: 768, height: 900 });
    const touchpointTable = report
      .locator("section")
      .filter({ has: page.getByRole("heading", { level: 2, name: "5. Exchange touchpoints" }) })
      .locator("th, td");
    expect(await overflowing(touchpointTable), "report §5 cells wider than their column").toEqual(
      [],
    );
  });
}

test("⌘K finds an address of the open run; Esc returns focus to the opener", async ({ page }) => {
  const runId = await runDemo(page, FAST_DEMO);
  const response = await page.request.get(`/api/runs/${runId}`);
  expect(response.ok()).toBe(true);
  const run: { result: AnalysisResult | null } = await response.json();
  const address = run.result?.graph.addresses[0]?.address;
  if (!address) throw new Error("The finished run has no addresses");
  const palette = page.getByRole("dialog", { name: "Search" });
  const searchButton = page.getByRole("button", { name: /^Search address, tx or label/ });
  await searchButton.click();
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(searchButton).toBeFocused();

  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder("Search address, tx or label").fill(address);
  const short = new RegExp(`${address.slice(0, 6)}…${address.slice(-4)}`, "i");
  await expect(palette.getByRole("option").filter({ hasText: short }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  const panel = page.getByRole("complementary", { name: "Selection details" });
  await expect(panel.getByText(address, { exact: true })).toBeVisible();
});

test("pages have one h1 and ordered headings; Esc closes the detail panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("DEMO-ONLY INSTANCE")).toBeVisible();
  await expectHeadingOutline(page, "Home");

  const runId = await runDemo(page, FAST_DEMO);
  await page.getByRole("tab", { name: /^Transfers/ }).click();
  const row = page.getByRole("tabpanel").locator('tr[tabindex="0"]').first();
  await row.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Selection details" });
  await expect(panel).toBeVisible();
  await expect(panel.locator("aside")).toHaveCount(0);
  await expectHeadingOutline(page, "workspace with the detail panel");
  // From the opener: the panel closes and focus stays.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(row).toBeFocused();
  // From inside the panel: focus returns to the opener.
  await page.keyboard.press("Enter");
  await panel.getByRole("button", { name: "Close detail panel" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(row).toBeFocused();

  await page.goto(`/runs/${runId}/report`);
  await expect(page.getByRole("heading", { level: 1, name: FAST_DEMO })).toBeVisible();
  await expectHeadingOutline(page, "report");
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "History" })).toBeVisible();
  await expectHeadingOutline(page, "History");
});

test("unknown pages and runs have an h1 and a link back", async ({ page, consoleErrors }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expectHeadingOutline(page, "404");
  await page.getByRole("main").getByRole("link", { name: "Back to Home" }).click();
  await expect(page.getByText("DEMO-ONLY INSTANCE")).toBeVisible();

  for (const path of ["/runs/does-not-exist", "/runs/does-not-exist/report"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Unknown run" })).toBeVisible();
    await expect(
      page.getByRole("main").getByRole("link", { name: "Back to history" }),
    ).toBeVisible();
    await expectHeadingOutline(page, path);
  }
  // The API answers 404 for the unknown run, and the browser logs each of those requests.
  expect(consoleErrors.every((error) => error.includes("404"))).toBe(true);
  consoleErrors.length = 0;
});

test("a demo-only instance offers no rename, notes or delete", async ({ page }) => {
  await runDemo(page, FAST_DEMO);
  await expect(page.getByRole("link", { name: "Open report" })).toBeVisible();
  await expect(page.getByRole("button", { name: "✎ Rename", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "✎ Notes", exact: true })).toHaveCount(0);
  await page.goto("/runs");
  await expect(page.getByRole("link", { name: FAST_DEMO, exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Delete / })).toHaveCount(0);
});

test("the screening result belongs to the screened chain and address", async ({ page }) => {
  const binance14 = "0x28c6c06298d514db089934071355e5743bf21d60";
  const unlabeled = "0x1234567890abcdef1234567890abcdef12345678";
  await page.goto("/");
  await expect(page.getByText("DEMO-ONLY INSTANCE")).toBeVisible();
  const box = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("Screen an address", { exact: true }) });
  const input = box.getByRole("textbox", { name: "Address to screen" });
  const screen = box.getByRole("button", { name: "Screen", exact: true });
  const binance = box.getByText("Binance 14", { exact: true });
  const unavailable = box.getByText("Sanctions list unavailable: not screened against OFAC");

  await input.fill(binance14);
  await screen.click();
  await expect(binance).toBeVisible();
  await expect(unavailable).toBeVisible();
  await expect(box.getByText("○ NO SDN MATCH")).toHaveCount(0);
  await input.fill(unlabeled);
  await expect(binance).toBeHidden();
  await expect(unavailable).toBeHidden();

  // A response for a superseded query must not replace the current result.
  const held = Promise.withResolvers<void>();
  await page.route(`**/api/screen/ethereum/${unlabeled}`, async (route) => {
    await held.promise;
    await route.continue();
  });
  await screen.click();
  await input.fill(binance14);
  await screen.click();
  await expect(binance).toBeVisible();
  const late = page.waitForResponse((response) => response.url().endsWith(unlabeled));
  held.resolve();
  await late;
  // Give the late response time to render before checking that it did not.
  await page.waitForTimeout(250);
  await expect(binance).toBeVisible();
  await expect(box.getByText("○ No label")).toBeHidden();

  await page.getByRole("button", { name: /^Chain Ethereum/ }).click();
  await page.getByRole("menuitem", { name: /^Polygon/ }).click();
  await expect(binance).toBeHidden();
});

test.describe("phone (390 px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Path view, exposure, full graph and the ☰ menu", async ({ page }) => {
    await runDemo(page, FAST_DEMO);
    await expect(page.getByRole("tab", { name: /^Path/ })).toHaveAttribute("aria-selected", "true");
    const path = page.getByRole("region", { name: "Highest-value path" });
    await expect(path.getByRole("listitem").first()).toBeVisible();

    // Stacked rows keep every USD amount inside the 390 px viewport.
    await page.getByRole("tab", { name: /^Exposure/ }).click();
    const byCategory = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { level: 2, name: "By category" }) });
    await byCategory.scrollIntoViewIfNeeded();
    const amounts = byCategory.getByText(/^\$[\d,]+\.\d{2}$/);
    await expect(amounts.first()).toBeVisible();
    for (const amount of await amounts.all()) await expect(amount).toBeInViewport({ ratio: 1 });
    await page.getByRole("tab", { name: /^Path/ }).click();
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
    // The menu item is gone with the menu, so focus returns to ☰.
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  });

  test("every control is at least 44 × 44 px", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("DEMO-ONLY INSTANCE")).toBeVisible();
    expect(await smallTargets(page), "Home").toEqual([]);
    await runDemo(page, FAST_DEMO);
    expect(await smallTargets(page), "Path").toEqual([]);
    for (const name of [/^Touchpoints/, /^Flags/, /^Transfers/]) {
      const tab = page.getByRole("tab", { name });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      expect(await smallTargets(page), `${name} tab`).toEqual([]);
    }
    await page.getByRole("tab", { name: /^Path/ }).click();
    await page
      .getByRole("region", { name: "Highest-value path" })
      .getByRole("button")
      .first()
      .click();
    const sheet = page.getByRole("dialog", { name: "Selection details" });
    await expect(sheet).toBeVisible();
    expect(await smallTargets(page), "detail sheet").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.locator("#mobile-navigation")).toBeVisible();
    expect(await smallTargets(page), "☰ menu").toEqual([]);
    await page.goto("/runs");
    await expect(
      page
        .getByRole("link", { name: `Open investigation ${FAST_DEMO}`, exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    expect(await smallTargets(page), "History").toEqual([]);
  });
});
