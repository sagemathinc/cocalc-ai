// Read-only link acceptance. Supply a fixture whose current thread directory
// differs from the archived config directory; never changes thread settings.
import { createRequire } from "node:module";
import { historySelect } from "./history-select.browser-helper.mjs";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [chat, commit, expectedDirectory] = process.argv.slice(2);
if (
  !chat ||
  !/^[a-f0-9]{40,64}$/.test(commit ?? "") ||
  !expectedDirectory?.startsWith("/")
)
  throw Error(
    "Supply fixture chat URL, full commit hash, and archived directory.",
  );
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.addInitScript(() => {
    window.__reviewNavigation = [];
    const record = (kind) => {
      window.__reviewNavigation.push({
        kind,
        href: location.href,
        at: performance.now(),
      });
      if (window.__reviewNavigation.length > 50)
        window.__reviewNavigation.shift();
    };
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name].bind(history);
      history[name] = (...args) => {
        const result = original(...args);
        record(name);
        return result;
      };
    }
    for (const name of ["popstate", "cocalc:app-navigation"])
      window.addEventListener(name, () => record(name));
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(chat, { waitUntil: "domcontentloaded" });
  const link = page.locator(`a[href="cocalc-commit://${commit}"]`).first();
  await expect(link).toBeVisible({ timeout: 60000 });
  const warning = page.getByRole("button", {
    name: "Dismiss stale frontend build warning",
  });
  if (await warning.isVisible()) await warning.click();
  await link.scrollIntoViewIfNeeded();
  await link.press("Enter");
  console.log("After activation", page.url());
  await expect(historySelect(page, "Review working copy")).toContainText(
    expectedDirectory,
    { timeout: 60000 },
  );
  console.log("Archived directory selected", page.url());
  await expect(
    page.getByRole("region", { name: "Git diff", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await expect
    .poll(() => new URL(page.url()).searchParams.get("git-hash"), {
      timeout: 10000,
    })
    .toBe(commit);
  expect(errors).toEqual([]);
  console.log(
    "Passed: native keyboard commit link opens the archived turn directory rather than current thread settings, with Pierre and no page errors.",
  );
} catch (error) {
  console.error(
    "Navigation",
    await page.evaluate(() => window.__reviewNavigation),
  );
  console.error("Final URL", page.url());
  console.error((await page.locator("body").innerText()).slice(-4000));
  throw error;
} finally {
  await page.close();
}
process.exit(0);
