// Read-only live TimeTravel comparison smoke. Supply a .time-travel route for
// a text file with at least two versions. REVIEW_HISTORY_SOURCE defaults to Git;
// use Snapshots, Backups, or TimeTravel for source-specific fixtures. Never restores.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [url] = process.argv.slice(2);
const source = process.env.REVIEW_HISTORY_SOURCE ?? "Git";
if (!["Git", "Snapshots", "Backups", "TimeTravel"].includes(source))
  throw Error("Unsupported history source");
if (!url || !new URL(url).pathname.endsWith(".time-travel"))
  throw Error("Supply a TimeTravel URL for a multi-version Git text file.");
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const body = page.getByTestId("timetravel-body");
  await expect(body).toBeVisible({ timeout: 60000 });
  const scope = body.locator("..");
  await scope.getByRole("combobox").nth(0).click();
  await page
    .locator(`.ant-select-item-option[title=${JSON.stringify(source)}]`)
    .click();
  await expect(scope.locator(".ant-select").nth(0)).toContainText(source);
  const fileMode = scope.getByRole("radio", { name: "File", exact: true });
  await fileMode.locator("xpath=ancestor::label").click();
  await expect(fileMode).toBeChecked();
  await scope.getByRole("combobox").nth(2).click();
  const compare = page.locator(
    '.ant-select-item-option[title="Compare Changes"]',
  );
  await expect(
    compare,
    `${source} fixture needs at least two available versions`,
  ).not.toHaveClass(/ant-select-item-option-disabled/, { timeout: 15000 });
  await compare.click();
  await expect(scope.locator(".ant-select").nth(2)).toContainText(
    "Compare Changes",
  );
  const renderer = scope.getByRole("combobox", {
    name: "Text diff renderer",
    exact: true,
  });
  await expect(renderer).toHaveCount(0);
  await expect(body.locator("diffs-container [data-line]").first()).toBeVisible(
    { timeout: 60000 },
  );
  await expect(
    scope.getByRole("button", { name: "Restore This Version", exact: true }),
  ).toHaveCount(0);
  await expect(body.locator(".CodeMirror")).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    `Passed: live ${source} TimeTravel comparison uses Pierre only; no Classic selector or CodeMirror diff; restore absent in comparison mode; no page errors. No file mutation.`,
  );
} catch (error) {
  console.error(error);
  console.error(
    "Available version counts:",
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        '[data-testid="timetravel-body"]',
      )) {
        const key = Object.keys(element).find((key) =>
          key.startsWith("__reactFiber$"),
        );
        for (let fiber = element[key]; fiber; fiber = fiber.return) {
          const actions = fiber.memoizedProps?.actions;
          if (actions?.store && actions.docpath)
            return Object.fromEntries(
              [
                "versions",
                "git_versions",
                "snapshot_versions",
                "backup_versions",
              ].map((key) => [key, actions.store.get(key)?.size]),
            );
        }
      }
      return undefined;
    }),
  );
  console.error((await page.locator("body").innerText()).slice(-4000));
  process.exitCode = 1;
} finally {
  await page.close();
  process.exit(process.exitCode ?? 0);
}
