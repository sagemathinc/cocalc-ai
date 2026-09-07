// Read-only live TimeTravel comparison smoke. Supply a .time-travel route for
// a text file with at least two Git versions. Never clicks Restore.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [url] = process.argv.slice(2);
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
  await page.locator('.ant-select-item-option[title="Git"]').click();
  const fileMode = scope.getByRole("radio", { name: "File", exact: true });
  await fileMode.locator("xpath=ancestor::label").click();
  await expect(fileMode).toBeChecked();
  await scope.getByRole("combobox").nth(2).click();
  await page
    .locator('.ant-select-item-option[title="Compare Changes"]')
    .click();
  const renderer = scope.getByRole("combobox", {
    name: "Text diff renderer",
    exact: true,
  });
  await expect(renderer).toBeVisible({ timeout: 60000 });
  await renderer.selectOption("pierre");
  await expect(body.locator("diffs-container [data-line]").first()).toBeVisible(
    { timeout: 60000 },
  );
  await expect(
    scope.getByRole("button", { name: "Restore This Version", exact: true }),
  ).toHaveCount(0);
  await renderer.selectOption("classic");
  await expect(body.locator(".CodeMirror").first()).toBeVisible({
    timeout: 15000,
  });
  await expect(body.locator("diffs-container")).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    "Passed: live Git TimeTravel comparison in Pierre and Classic; restore absent in comparison mode; no page errors. No file mutation.",
  );
} catch (error) {
  console.error(error);
  console.error((await page.locator("body").innerText()).slice(-4000));
  process.exitCode = 1;
} finally {
  await page.close();
  process.exit(process.exitCode ?? 0);
}
