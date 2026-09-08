// Mutates only an explicitly named smoke fixture, through real UI + live APIs.
// Load the matching CoCalc CLI environment before running this test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [target] = process.argv.slice(2);
const source = process.env.REVIEW_HISTORY_SOURCE ?? "TimeTravel";
assert(["TimeTravel", "Git", "Snapshots", "Backups"].includes(source));
// Archive fixtures need only a Beta capture; live content remains Gamma.
const restoreLatest = process.env.REVIEW_RESTORE_LATEST === "1";
const url = new URL(target);
const match = decodeURIComponent(url.pathname).match(
  /^\/projects\/([^/]+)\/files\/(home\/user\/scratch\/(?:git-review-repo-[a-z0-9-]+\/)?)\.(git-review-timetravel-[a-z0-9-]+\.md)\.time-travel$/,
);
assert(match, "Only explicitly named scratch smoke fixtures can be restored");
const projectIdentifier = match[1],
  path = `/${match[2]}${match[3]}`;
const options = JSON.stringify({ path, projectIdentifier });
const gamma = "# Review history fixture\n\nGamma version.\n";
const beta = "# Review history fixture\n\nBeta version.\n";
function api(code) {
  const output = execFileSync(
    "/opt/cocalc/bin/node",
    ["/opt/cocalc/bin2/cocalc-cli.js", "--json", "exec", code],
    { encoding: "utf8", timeout: 60000 },
  );
  const result = JSON.parse(output);
  assert(result.ok, output);
  return result.data.result;
}
const read = () =>
  api(
    `const d = await api.text.open(${options}).read(); return {text:d.text, latestVersionId:d.latestVersionId};`,
  );
const original = read();
assert.equal(
  original.text,
  gamma,
  "Unexpected fixture contents; refusing to restore",
);
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
let attemptedRestore = false;
try {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  const body = page.getByTestId("timetravel-body");
  await expect(body).toBeVisible({ timeout: 60000 });
  const scope = body.locator("..");
  await scope.getByRole("combobox").nth(0).click();
  await page
    .locator(`.ant-select-item-option[title=${JSON.stringify(source)}]`)
    .click();
  await expect(scope.locator(".ant-select").nth(0)).toContainText(source);
  await scope
    .getByRole("radio", { name: "File", exact: true })
    .locator("xpath=ancestor::label")
    .click();
  await scope.getByRole("combobox").nth(2).click();
  await page.locator('.ant-select-item-option[title="Single Version"]').click();
  const latest = scope.getByTitle("Jump to most recent version", {
    exact: true,
  });
  if (await latest.isEnabled()) await latest.click();
  if (!restoreLatest) {
    await expect(body.getByTestId("timetravel-markdown-content")).toContainText(
      "Gamma version.",
    );
    await scope.getByTitle("Step to previous version", { exact: true }).click();
  }
  await expect(body.getByTestId("timetravel-markdown-content")).toContainText(
    "Beta version.",
  );
  const restore = scope.getByRole("button", {
    name: "Restore This Version",
    exact: true,
  });
  await expect(restore).toBeEnabled();
  await restore.focus();
  attemptedRestore = true;
  await page.keyboard.press("Enter");
  await expect
    .poll(() => read().text, { timeout: 30000, intervals: [1000, 2000] })
    .toBe(beta);
  assert.notEqual(read().latestVersionId, original.latestVersionId);
  const historical = api(
    `return {text:(await api.timetravel.open(${options}).readVersion(${JSON.stringify(original.latestVersionId)})).text};`,
  );
  assert.equal(
    historical.text,
    gamma,
    "Restore must retain the previous latest version",
  );
  console.log(
    `Passed (${source}): rich historical Markdown selected, keyboard Restore created a new live version, original Gamma version still readable.`,
  );
} finally {
  await page.close();
  if (attemptedRestore) {
    api(
      `const doc=api.text.open(${options}); const before=await doc.read(); if(before.text!==${JSON.stringify(beta)} && before.text!==${JSON.stringify(gamma)}) throw Error('Fixture changed unexpectedly; refusing cleanup'); if(before.text!==${JSON.stringify(gamma)}) await doc.write(${JSON.stringify(gamma)}, {expectedHash:before.hash}); return true;`,
    );
    assert.equal(read().text, gamma);
    console.log("Fixture returned to Gamma text; history retained.");
  }
}
process.exit(0);
