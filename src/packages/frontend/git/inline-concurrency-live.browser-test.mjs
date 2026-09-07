// Use a disposable commit: this leaves two private acceptance comments/drafts.
// REVIEW_RECONNECT=1 interrupts only the second tab's real WebSocket transport.
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
let transport;
async function open(interruptible = false) {
  const page = await browser.contexts()[0].newPage();
  pages.push(page);
  if (interruptible) {
    let offline = false;
    let admitted = 0;
    let rejected = 0;
    const sockets = new Set();
    await page.routeWebSocket("**/*", (socket) => {
      if (offline) {
        rejected++;
        void socket.close({
          code: 1012,
          reason: "Review reconnect acceptance",
        });
        return;
      }
      // Forward actual traffic unchanged; no synthetic service responses.
      const server = socket.connectToServer();
      admitted++;
      const pair = { socket, server };
      sockets.add(pair);
      socket.onClose((code, reason) => {
        sockets.delete(pair);
        void server.close({ code, reason });
      });
      server.onClose((code, reason) => {
        sockets.delete(pair);
        void socket.close({ code, reason });
      });
    });
    transport = {
      get admitted() {
        return admitted;
      },
      get rejected() {
        return rejected;
      },
      async disconnect() {
        assert(sockets.size > 0, "No live WebSockets to interrupt");
        offline = true;
        for (const { socket, server } of [...sockets]) {
          await socket.close({
            code: 1012,
            reason: "Review reconnect acceptance",
          });
          await server.close({
            code: 1012,
            reason: "Review reconnect acceptance",
          });
        }
      },
      reconnect() {
        offline = false;
      },
    };
  }
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
  const warning = page.getByRole("button", {
    name: "Dismiss stale frontend build warning",
  });
  if (await warning.isVisible()) await warning.click();
  return editor;
}
try {
  const first = await open();
  const second = await open(process.env.REVIEW_RECONNECT === "1");
  await draft(first, "Inline acceptance first window");
  await first.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(
    first.locator('[aria-label="Active inline comment"]'),
  ).toHaveCount(0);
  const editor = await draft(second, "Inline acceptance stale second window");
  if (transport) await transport.disconnect();
  await second
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  if (transport) {
    await expect
      .poll(() => transport.rejected, { timeout: 30000 })
      .toBeGreaterThan(0);
    await expect(editor).toBeVisible();
    await expect(editor).toContainText("Inline acceptance stale second window");
    const before = transport.admitted;
    transport.reconnect();
    await expect
      .poll(() => transport.admitted, { timeout: 30000 })
      .toBeGreaterThan(before);
  }
  if (transport) {
    await expect
      .poll(
        async () => {
          const add = second.getByRole("button", {
            name: "Add comment",
            exact: true,
          });
          return (
            (await add.count()) === 0 ||
            ((await add.isEnabled()) &&
              !(await add.getAttribute("class"))?.includes("ant-btn-loading"))
          );
        },
        {
          timeout: 90000,
          message: "Save must settle after transport reconnects",
        },
      )
      .toBe(true);
    console.log(
      "Reconnected save settled; verifying recovered persisted content.",
    );
  } else {
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
        return Object.keys(
          JSON.parse(localStorage.getItem(key)).comments,
        ).sort();
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
  }
  await second.reload({ waitUntil: "domcontentloaded" });
  for (const text of [
    "Inline acceptance first window",
    "Inline acceptance stale second window",
  ])
    await expect(second.getByText(text, { exact: true }).first()).toBeVisible({
      timeout: 60000,
    });
  await second.getByRole("checkbox", { name: "Reviewed", exact: true }).check();
  await expect
    .poll(() =>
      second.evaluate(
        (hash) =>
          !Object.keys(localStorage).some(
            (key) =>
              key.startsWith("cocalc:git-review:draft:v2:account:") &&
              key.endsWith(`:commit:${hash}`),
          ),
        hash,
      ),
    )
    .toBe(true);
  await second.reload({ waitUntil: "domcontentloaded" });
  for (const text of [
    "Inline acceptance first window",
    "Inline acceptance stale second window",
  ])
    await expect(second.getByText(text, { exact: true }).first()).toBeVisible({
      timeout: 60000,
    });
  console.log(
    transport
      ? "Passed: reload and resave preserved both independent comments after the recovery draft was cleared."
      : "Passed: stale inline save retained editor and identity; reload and resave preserved both independent comments after the recovery draft was cleared.",
  );
  if (transport)
    console.log(
      "Passed: real tab WebSockets disconnected, reconnect attempts rejected, editor retained, then actual transport reconnected and both comments survived resave/reload.",
    );
  if (process.env.REVIEW_EDIT_CONFLICT === "1") {
    await first.reload({ waitUntil: "domcontentloaded" });
    async function edit(page, body) {
      await page.bringToFront();
      const original = page
        .getByText("Inline acceptance first window", { exact: true })
        .first();
      await expect(original).toBeVisible({ timeout: 60000 });
      await original
        .locator("xpath=ancestor::div[.//button[normalize-space()='Edit']][1]")
        .getByRole("button", { name: "Edit", exact: true })
        .click();
      const editor = page
        .locator('[contenteditable="true"]')
        .filter({ hasText: "Inline acceptance first window" });
      await expect(editor).toBeVisible();
      await editor.evaluate((element, body) => {
        let fiber =
          element[
            Object.keys(element).find((key) => key.startsWith("__reactFiber"))
          ];
        while (fiber && !fiber.memoizedProps?.editor?.insertText)
          fiber = fiber.return;
        const slate = fiber.memoizedProps.editor;
        slate.select({
          anchor: { path: [0, 0], offset: 0 },
          focus: {
            path: [0, 0],
            offset: slate.children[0].children[0].text.length,
          },
        });
        slate.insertText(body);
      }, body);
      await page.getByRole("button", { name: "Save", exact: true }).click();
    }
    await edit(first, "Remote edited version");
    await expect(
      first.getByRole("button", { name: "Save", exact: true }),
    ).toHaveCount(0);
    await edit(second, "Local edited alternative");
    await expect(
      second.getByText(/another window may have changed it/),
    ).toBeVisible();
    await second.reload({ waitUntil: "domcontentloaded" });
    for (const body of ["Remote edited version", "Local edited alternative"])
      await expect(second.getByText(body, { exact: true }).first()).toBeVisible(
        { timeout: 60000 },
      );
    await expect(
      second.getByText(/Recovered local alternative.*Not sent to the agent/),
    ).toBeVisible();
    console.log(
      "Passed: same-ID conflicting edit reload preserves both labelled alternatives.",
    );
  }
} finally {
  transport?.reconnect();
  for (const page of pages) await page.close();
}
process.exit(0);
