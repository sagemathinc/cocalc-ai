// Signed-in CDP smoke test against a caller-supplied Markdown review fixture.
// Usage: node .../historical-file.browser-test.mjs <chat-url> <commit> <diff-path>
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [chatUrl, commit, path] = process.argv.slice(2);
if (
  !chatUrl ||
  !/^[a-f0-9]{7,64}$/i.test(commit ?? "") ||
  !path?.endsWith(".md")
) {
  throw Error(
    "Supply a chat URL, commit, and Markdown path in that commit's diff.",
  );
}
const url = new URL(chatUrl);
const expectedCommit = process.env.REVIEW_SOURCE_COMMIT ?? commit;
const expectedPath = process.env.REVIEW_SOURCE_PATH ?? path;
let expectedContents;
if (process.env.REVIEW_SOURCE_COMMIT) {
  if (!/^[a-f0-9]{40,64}$/.test(expectedCommit))
    throw Error("Expected source must be a full hash");
  const result = JSON.parse(
    execFileSync(
      "/opt/cocalc/bin/node",
      [
        "/opt/cocalc/bin2/cocalc-cli.js",
        "--json",
        "project",
        "exec",
        "-w",
        url.pathname.match(/\/projects\/([^/]+)\/files\//)[1],
        "--path",
        "/home/user/cocalc-ai",
        "--",
        "git",
        "show",
        `${expectedCommit}:${expectedPath}`,
      ],
      { encoding: "utf8", timeout: 90000 },
    ),
  );
  if (result.data?.exit_code !== 0) throw Error(JSON.stringify(result));
  expectedContents = result.data.stdout;
}
url.searchParams.set("git-hash", commit);
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
const errors = [];
let previousRenderer;
const mode = process.env.REVIEW_RENDERER ?? "legacy";
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.bringToFront();
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  const renderer = page.getByRole("combobox", {
    name: "Diff renderer",
    exact: true,
  });
  await expect(renderer).toBeVisible({ timeout: 60000 });
  previousRenderer = await renderer.inputValue();
  await renderer.selectOption(mode);
  await page.locator(".ant-drawer-body").evaluate((body) => {
    for (const e of body.querySelectorAll("div"))
      if (getComputedStyle(e).overflowY === "auto") e.scrollTop = 0;
  });
  await page
    .getByRole("combobox", { name: "Changed files", exact: true })
    .selectOption({ label: path });
  const section =
    mode === "pierre"
      ? page.locator(`[data-review-file-header=${JSON.stringify(path)}]`)
      : page.locator('[data-git-diff-section="true"]').filter({
          has: page.getByRole("button", { name: path, exact: true }),
        });
  if (process.env.REVIEW_SIDE === "old" && mode === "pierre")
    await section
      .getByRole("button", { name: `More file actions: ${path}` })
      .click();
  const open =
    process.env.REVIEW_SIDE === "old" && mode === "pierre"
      ? page.getByRole("menuitem", {
          name: "View before this change",
          exact: true,
        })
      : section.getByRole("button", {
          name:
            process.env.REVIEW_SIDE === "old"
              ? "View before this change"
              : "View at this revision",
          exact: true,
        });
  await expect(open).toBeVisible({ timeout: 60000 });
  await expect(open).toBeInViewport();
  if (process.env.REVIEW_ACTIVATE === "pointer") await open.click();
  else await open.press("Enter");
  const modal = page.getByRole("dialog", { name: "TimeTravel: Git revision" });
  await expect(modal.getByTestId("timetravel-markdown-content")).toBeVisible({
    timeout: 30000,
  });
  await expect(modal.getByText(expectedCommit, { exact: true })).toBeVisible();
  await expect(modal.getByText(expectedPath, { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "Source text", exact: true }).click();
  const source = modal.locator(".CodeMirror");
  expect(await source.evaluate((e) => e.CodeMirror.getOption("readOnly"))).toBe(
    true,
  );
  const contents = await source.evaluate((e) => e.CodeMirror.getValue());
  if (expectedContents !== undefined) expect(contents).toBe(expectedContents);
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
  if (process.env.REVIEW_SIDE === "old" && mode === "pierre")
    await expect(
      section.getByRole("button", { name: `More file actions: ${path}` }),
    ).toBeFocused();
  else await expect(open).toBeFocused();
  expect(new URL(page.url()).searchParams.get("git-hash")).toBe(commit);
  expect(errors).toEqual([]);
  console.log(
    `Passed (${mode}, ${process.env.REVIEW_ACTIVATE ?? "keyboard"}, ${process.env.REVIEW_SIDE ?? "default"} side): rich historical Markdown, exact revision/path${expectedContents === undefined ? "" : "/contents"}, read-only source, line jump, keyboard close/focus, unchanged review URL.`,
  );
} catch (error) {
  console.error(
    "Historical dialog",
    await page
      .getByRole("dialog", { name: "TimeTravel: Git revision" })
      .allTextContents(),
  );
  console.error("Browser errors", errors);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (previousRenderer)
    await page
      .getByRole("combobox", { name: "Diff renderer", exact: true })
      .selectOption(previousRenderer)
      .catch(() => {});
  await page.close();
  process.exit(process.exitCode ?? 0);
}
