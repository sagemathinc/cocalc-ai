// Signed-in smoke test; creates and closes only its own CDP tab.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [chatUrl, commit] = process.argv.slice(2);
if (!chatUrl || !/^[a-f0-9]{7,40}$/i.test(commit ?? ""))
  throw Error("Supply a chat URL and commit with multiple changed files.");
const url = new URL(chatUrl);
url.searchParams.set("git-hash", commit);
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.setViewportSize({ width: 2000, height: 1000 });
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  const select = page.getByRole("combobox", {
    name: "Changed files",
    exact: true,
  });
  await expect(select).toBeVisible({ timeout: 60000 });
  const paths = await select
    .locator("option")
    .evaluateAll((options) => options.slice(1).map((o) => o.textContent));
  expect(paths.length).toBeGreaterThan(1);
  const tree = page.getByRole("complementary", {
    name: "Changed-file navigation",
  });
  await expect(tree).toBeVisible();
  const filter = tree.getByRole("searchbox", { name: "Filter changed files" });
  await filter.fill(paths.at(-1).split("/").at(-1));
  const row = tree.getByRole("treeitem").last();
  await row.click();
  const target = page.locator(`[data-review-file-id="${paths.length - 1}"]`);
  await expect(target).toBeVisible();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Hide file tree" }).click();
  await expect(tree).toBeHidden();
  await page.getByRole("button", { name: "Show file tree" }).click();
  await expect(tree).toBeVisible();
  await expect(filter).toHaveValue(paths.at(-1).split("/").at(-1));
  await select.selectOption("0");
  await expect(page.locator('[data-review-file-id="0"]')).toBeVisible();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(tree).toBeHidden();
  await select.selectOption(String(paths.length - 1));
  await expect(target).toBeVisible();
  expect(new URL(page.url()).searchParams.get("git-hash")).toBe(commit);
  expect(errors).toEqual([]);
  console.log(
    "Passed: main drawer Trees selection, active highlight, collapse/reopen preserving filter, compact navigation, unchanged review target.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await page.close();
  process.exit(process.exitCode ?? 0);
}
