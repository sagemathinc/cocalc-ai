// Keyboard and remount acceptance; restores the browser's original preference.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect: baseExpect } = require("@playwright/test");
const expect = baseExpect.configure({ timeout: 60000 });
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
const key = "cocalc:chat:gitCommitDrawer:showDetails";
let original;
try {
  const warning = page.getByRole("button", {
    name: "Dismiss stale frontend build warning",
  });
  await page.addLocatorHandler(warning, () => warning.click());
  await page.goto(process.argv[2]);
  const summary = page
    .locator("summary")
    .filter({ hasText: /^Commit details$/ });
  await expect(summary).toBeVisible();
  original = await page.evaluate((key) => localStorage.getItem(key), key);
  const details = summary.locator("..");
  if (!(await details.evaluate((node) => node.open))) {
    await summary.focus();
    await page.keyboard.press("Enter");
  }
  await expect(details).toHaveAttribute("open", "");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key))
    .toBe("true");
  const before = new URL(page.url()).searchParams.get("git-hash");
  await page.getByRole("button", { name: "Older", exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("git-hash"))
    .not.toBe(before);
  await expect(details).toHaveAttribute("open", "");
  await page.reload();
  await expect(details).toHaveAttribute("open", "");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key))
    .toBe("false");
  await page.reload();
  await expect(summary).toBeVisible();
  await expect(details).not.toHaveAttribute("open");
  console.log(
    "PASS: keyboard details toggle persists across commits and reload, expanded and collapsed",
  );
} finally {
  if (original !== undefined)
    await page.evaluate(
      ({ key, original }) => {
        if (original === null) localStorage.removeItem(key);
        else localStorage.setItem(key, original);
      },
      { key, original },
    );
  await page.close();
}
process.exit(0);
