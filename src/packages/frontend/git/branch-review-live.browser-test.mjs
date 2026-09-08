// Read-only acceptance: originating message -> unique branch/worktree -> comparison.
// Usage: node branch-review-live.browser-test.mjs <message-url> <short-sha> <branch>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [url, commit, branch] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(30000);
try {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const warning = page.getByRole("button", {
    name: "Dismiss stale frontend build warning",
  });
  await page.addLocatorHandler(warning, () => warning.click());
  await page.goto(url);
  if (process.env.REVIEW_SOURCE_THREAD_LABEL) {
    await page
      .getByRole("menuitem", {
        name: process.env.REVIEW_SOURCE_THREAD_LABEL,
        exact: false,
      })
      .click();
  }
  await page.getByText(new RegExp(commit)).first().click({ timeout: 60000 });
  const branchSelect = page.getByRole("combobox", {
    name: "Branch / ref",
    exact: true,
  });
  await expect(
    branchSelect.locator("xpath=..").locator("xpath=.."),
  ).toContainText(branch, { timeout: 60000 });
  await expect
    .poll(() => new URL(page.url()).searchParams.get("git-ref"))
    .toBe(`refs/heads/${branch}`);
  const cwd = new URL(page.url()).searchParams.get("git-cwd");
  await expect(
    page
      .getByRole("combobox", { name: "Review working copy" })
      .locator("xpath=..")
      .locator("xpath=.."),
  ).toContainText(cwd);
  await expect(
    page.getByText("Loading commit title...", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Compare revisions...", exact: true })
    .click();
  const section = page.getByRole("region", { name: "Compare branch commits" });
  // A named section is exposed as a region by the accessibility tree.
  await expect(section.getByRole("status")).toContainText("commits loaded", {
    timeout: 60000,
  });
  for (const name of ["Before commit", "After commit"]) {
    const input = section.getByRole("combobox", { name, exact: true });
    await input.click();
    await input.press("ArrowDown");
    if (name === "Before commit") await input.press("ArrowDown");
    await input.press("Enter");
  }
  await section
    .getByRole("button", { name: "Compare commits", exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("git-compare"), {
      timeout: 60000,
    })
    .toBeTruthy();
  console.log(
    "PASS: message commit selects unique branch/worktree; comparison uses selectable commits",
    { cwd, branch },
  );
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-12000));
  throw error;
} finally {
  await page.close();
}
process.exit(0);
