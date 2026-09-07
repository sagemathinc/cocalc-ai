// Use a disposable commit: this leaves two private acceptance comments/drafts.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [chat, hash] = process.argv.slice(2);
assert(/^[a-f0-9]{40,64}$/.test(hash ?? ""));
const url = new URL(chat);
url.searchParams.set("git-hash", hash);
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const pages = [];
async function open() {
  const page = await browser.contexts()[0].newPage();
  pages.push(page);
  await page.bringToFront();
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("combobox", { name: "Changed files", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await expect(
    page.getByText("Loading review state...", { exact: true }),
  ).toHaveCount(0);
  return page;
}
async function draft(page, text) {
  await page.bringToFront();
  // Select through the real Pierre gutter and edit through the real Slate instance.
  await page
    .getByRole("combobox", { name: "Diff renderer", exact: true })
    .selectOption("pierre");
  await page
    .getByRole("combobox", { name: "Changed files", exact: true })
    .selectOption({ index: 1 });
  await page
    .locator("diffs-container [data-gutter] [data-line-number-content]")
    .first()
    .click();
  await page
    .getByRole("button", { name: "Add inline comment", exact: true })
    .click();
  const editor = page.locator(
    '[aria-label="Active inline comment"] [contenteditable="true"]',
  );
  await expect(editor).toBeVisible();
  await editor.evaluate((element, text) => {
    let fiber =
      element[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))
      ];
    while (fiber && !fiber.memoizedProps?.editor?.insertText)
      fiber = fiber.return;
    if (!fiber) throw Error("Slate missing");
    fiber.memoizedProps.editor.select({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    });
    fiber.memoizedProps.editor.insertText(text);
  }, text);
  return editor;
}
try {
  const first = await open();
  const second = await open();
  await draft(first, "Inline acceptance first window");
  await first.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(
    first.locator('[aria-label="Active inline comment"]'),
  ).toHaveCount(0);
  const editor = await draft(second, "Inline acceptance stale second window");
  await second
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  await expect(
    second.getByText(/another window may have changed it/),
  ).toBeVisible({ timeout: 30000 });
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Inline acceptance stale second window");
  const draftIds = () =>
    second.evaluate((hash) => {
      const key = Object.keys(localStorage).find(
        (key) =>
          key.startsWith("cocalc:git-review:draft:v2:account:") &&
          key.endsWith(`:commit:${hash}`),
      );
      if (!key) throw Error("Recovery draft missing");
      return Object.keys(JSON.parse(localStorage.getItem(key)).comments).sort();
    }, hash);
  const ids = await draftIds();
  assert(ids.length > 0);
  await second
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  await expect(
    second.getByText(/another window may have changed it/),
  ).toBeVisible();
  assert.deepEqual(
    await draftIds(),
    ids,
    "Retry must not insert another comment identity",
  );
  await expect(editor).toBeVisible();
  console.log(
    "Passed: stale inline save rejected with real Slate editor and text retained; retry preserves comment identity.",
  );
} finally {
  for (const page of pages) await page.close();
}
process.exit(0);
