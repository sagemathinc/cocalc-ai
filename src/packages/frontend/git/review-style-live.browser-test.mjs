// Read-only layout and disclosure acceptance in the signed-in development browser.
// Usage: node review-style-live.browser-test.mjs <git-review-url>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect: baseExpect } = require("@playwright/test");
const expect = baseExpect.configure({ timeout: 60000 });
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(60000);
let appearance;
const height = Number(process.env.VIEWPORT_HEIGHT ?? 1000);
try {
  await page.setViewportSize({ width: 1440, height });
  const warning = page.getByRole("button", {
    name: "Dismiss stale frontend build warning",
  });
  await page.addLocatorHandler(warning, () => warning.click());
  await page.goto(process.argv[2]);
  const theme = page.getByRole("combobox", { name: "Appearance", exact: true });
  await theme.waitFor();
  appearance = await theme.inputValue();
  for (const mode of ["light", "dark"]) {
    await theme.selectOption(mode);
    await expect(
      page.getByRole("combobox", { name: "Commit", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("[data-review-file-header]").first(),
    ).toBeVisible();
    const options = page.getByText("History options", { exact: true });
    await options.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("checkbox", { name: "First-parent history", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("checkbox", { name: "First-parent history", exact: true }),
    ).not.toBeVisible();
    await page.screenshot({ path: `/tmp/git-review-${mode}.png` });
    const header = page.locator("[data-review-file-header]").first();
    await header.hover();
    await page.mouse.wheel(0, 650);
    await expect
      .poll(async () => (await header.boundingBox())?.y ?? 10000)
      .toBeLessThan(160);
    await page.screenshot({ path: `/tmp/git-reading-${mode}.png` });
    // Home restores access to the setup controls, not just the first diff row.
    await header.click();
    await page.keyboard.press("Home");
    if (process.env.READING_ONLY === "1") {
      await expect(
        page.getByRole("button", { name: "Compare revisions...", exact: true }),
      ).toBeInViewport();
      continue;
    }
    await page
      .getByRole("button", { name: "Compare revisions...", exact: true })
      .click();
    const comparison = page.getByRole("region", {
      name: "Compare branch commits",
      exact: true,
    });
    await expect(comparison.getByRole("status")).toContainText(
      "commits loaded",
    );
    for (const name of ["Before commit", "After commit"]) {
      const input = comparison.getByRole("combobox", { name, exact: true });
      await input.click();
      await input.press("ArrowDown");
      if (name === "Before commit") await input.press("ArrowDown");
      await input.press("Enter");
    }
    await comparison
      .getByRole("button", { name: "Compare commits", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Comparison review", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Comparison review", exact: true })
        .locator("[data-review-file-header]")
        .first(),
    ).toBeVisible();
    await page.screenshot({ path: `/tmp/git-comparison-${mode}.png` });
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(
      comparison.getByRole("button", { name: "Compare commits", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: `/tmp/git-comparison-${mode}-narrow.png` });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("combobox", { name: "Commit", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: `/tmp/git-review-${mode}-narrow.png` });
    await page.setViewportSize({ width: 1440, height });
  }
  expect(errors).toEqual([]);
  console.log(
    process.env.READING_ONLY === "1"
      ? "PASS: light/dark reading viewport, wheel handoff and Home return; no page errors"
      : "PASS: light/dark review and comparison layouts, keyboard history disclosure, selectable comparisons; no page errors",
  );
} finally {
  if (appearance)
    await page
      .getByRole("combobox", { name: "Appearance", exact: true })
      .selectOption(appearance);
  await page.close();
}
process.exit(0);
