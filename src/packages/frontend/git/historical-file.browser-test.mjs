// Signed-in CDP smoke test against a caller-supplied Markdown review fixture.
// Usage: node .../historical-file.browser-test.mjs <chat-url> <commit> <diff-path>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [chatUrl, commit, path] = process.argv.slice(2);
if (
  !chatUrl ||
  !/^[a-f0-9]{7,40}$/i.test(commit ?? "") ||
  !path?.endsWith(".md")
) {
  throw Error(
    "Supply a chat URL, commit, and Markdown path in that commit's diff.",
  );
}
const url = new URL(chatUrl);
url.searchParams.set("git-hash", commit);
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  const section = page
    .locator('[data-git-diff-section="true"]')
    .filter({ has: page.getByRole("button", { name: path, exact: true }) });
  const open = section.getByRole("button", {
    name: "View at this revision",
    exact: true,
  });
  await expect(open).toBeVisible({ timeout: 60000 });
  await open.focus();
  await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name: "TimeTravel: Git revision" });
  await expect(modal.getByTestId("timetravel-markdown-content")).toBeVisible({
    timeout: 30000,
  });
  await expect(modal.getByText(commit, { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "Source text", exact: true }).click();
  const source = modal.locator(".CodeMirror");
  expect(await source.evaluate((e) => e.CodeMirror.getOption("readOnly"))).toBe(
    true,
  );
  const contents = await source.evaluate((e) => e.CodeMirror.getValue());
  const line = Math.min(50, contents.split("\n").length);
  await modal
    .getByRole("spinbutton", { name: "Historical source line" })
    .fill(String(line));
  await modal.getByRole("button", { name: "Go to source line" }).click();
  await expect
    .poll(() => source.evaluate((e) => e.CodeMirror.getCursor().line))
    .toBe(line - 1);
  await page.keyboard.type("must not edit");
  expect(await source.evaluate((e) => e.CodeMirror.getValue())).toBe(contents);
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(new URL(page.url()).searchParams.get("git-hash")).toBe(commit);
  expect(errors).toEqual([]);
  console.log(
    "Passed: rich historical Markdown, read-only original source, exact line jump, keyboard close/focus, unchanged review URL.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await page.close();
  process.exit(process.exitCode ?? 0);
}
