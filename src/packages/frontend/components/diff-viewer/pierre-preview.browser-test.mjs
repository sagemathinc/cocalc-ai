// Standalone Chromium regression: real React, Ant Design, and Pierre. Only
// application services and the rich editor are stubbed; no account login needed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../package.json", import.meta.url));
const { build } = require("esbuild");
const { chromium, expect } = require("@playwright/test");

const patch = ["first.ts", "second.ts"]
  .map(
    (name) =>
      `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,201 +1,201 @@\n-const value = 1;\n+const value = 2;\n` +
      Array.from(
        { length: 200 },
        (_, i) =>
          ` // ${name} line ${i + 2} ${i === 0 ? "long source ".repeat(250) : "context"}\n`,
      ).join(""),
  )
  .join("");
const built = await build({
  absWorkingDir: frontend,
  stdin: {
    resolveDir: frontend,
    contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { DiffPreviewButton } from './components/diff-viewer/preview-button';
      function Harness() {
        const [fontSize, setFontSize] = React.useState(14);
        window.previewSetFontSize = setFontSize;
        return <DiffPreviewButton fontSize={fontSize} getSource={() => ({kind:'patch',label:'Browser fixture',patch:${JSON.stringify(patch)}})} />;
      }
      createRoot(document.getElementById('root')).render(<Harness />);`,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "application-service-stubs",
      setup(builder) {
        builder.onResolve(
          {
            filter:
              /^@cocalc\/frontend\/(app-framework|chat\/git-commit\/review-editors)$/,
          },
          ({ path }) => ({ path, namespace: "stub" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          contents: path.endsWith("app-framework")
            ? "export const redux = {getActions: () => undefined}"
            : "export function MarkdownHistoryInput({value,onChange}) {return <textarea aria-label='Temporary comment' value={value} onChange={e=>onChange(e.target.value)}/>}",
          loader: "tsx",
          resolveDir: frontend,
        }));
      },
    },
  ],
});
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/app.js" ? "application/javascript" : "text/html",
  );
  res.end(
    req.url === "/app.js"
      ? built.outputFiles[0].contents
      : '<!doctype html><html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "Preview with Pierre" }).click();
  await page.getByRole("combobox", { name: "Preview file" }).waitFor();
  const viewport = page.locator(".cocalc-pierre-preview-viewport");
  const diff = page.locator("diffs-container pre[data-diff]").first();
  await expect(diff).toHaveAttribute("data-diff-type", "single");
  await expect(diff).toHaveAttribute("data-overflow", "wrap");
  // Verify the rendered GitHub palette, not just the options passed to React.
  for (const [colorScheme, background] of [
    ["light", "rgb(255, 255, 255)"],
    ["dark", "rgb(36, 41, 46)"],
  ]) {
    await page.emulateMedia({ colorScheme });
    await expect
      .poll(() => diff.evaluate((e) => getComputedStyle(e).backgroundColor))
      .toBe(background);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expect
    .poll(() => viewport.evaluate((e) => getComputedStyle(e).overflowY))
    .toBe("auto");
  const rect = await viewport.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 100);
  await page.mouse.wheel(0, 900);
  await expect
    .poll(() => viewport.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(500);
  const pinnedHeader = async (name) => {
    await expect
      .poll(async () => {
        const header = await page
          .getByText(name, { exact: true })
          .last()
          .boundingBox();
        const frame = await viewport.boundingBox();
        return header != null && header.y >= frame.y && header.y < frame.y + 60;
      })
      .toBe(true);
  };
  await pinnedHeader("first.ts");
  const pathButton = page.getByRole("button", {
    name: "Copy repository-relative path: first.ts",
    exact: true,
  });
  await pathButton.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "first.ts",
  );
  await page.evaluate(() => navigator.clipboard.writeText("keep selection"));
  await pathButton.evaluate((button) => {
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(button);
    selection.addRange(range);
    button.click();
  });
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "keep selection",
  );
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.evaluate(() => window.previewSetFontSize(22));
  await expect(pathButton).toHaveCSS("font-size", "22px");
  await pinnedHeader("first.ts");
  const header = pathButton.locator("..");
  await expect(header).toHaveCSS("height", "77px");
  assert.equal(
    await header.evaluate((node) => node.scrollHeight <= node.clientHeight),
    true,
  );
  await page.evaluate(() => window.previewSetFontSize(14));
  await page.evaluate(() => {
    window.previewEscapedKeys = [];
    window.addEventListener("keydown", (event) =>
      window.previewEscapedKeys.push(event.key),
    );
  });
  const region = page.getByRole("region", { name: "Diff preview" });
  await region.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBe(0);
  await page.keyboard.press("Space");
  await expect
    .poll(() => viewport.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(200);
  await page.keyboard.press("Shift+Space");
  await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBe(0);
  await page.keyboard.press("PageDown");
  await expect
    .poll(() => viewport.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(200);
  await page.keyboard.press("PageUp");
  await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBe(0);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBe(40);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => viewport.evaluate((e) => e.scrollTop)).toBe(0);
  await page.keyboard.press("j");
  await page.keyboard.press("y");
  assert.deepEqual(await page.evaluate(() => window.previewEscapedKeys), []);
  await page.getByRole("checkbox", { name: "Side by side" }).check();
  await expect(diff).toHaveAttribute("data-diff-type", "split");
  await page.getByRole("combobox", { name: "Preview file" }).selectOption("1");
  const second = page.getByText("second.ts", { exact: true }).last();
  await expect
    .poll(async () => {
      const file = await second.boundingBox(),
        frame = await viewport.boundingBox();
      return (
        file != null && file.y >= frame.y && file.y < frame.y + frame.height
      );
    })
    .toBe(true);
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveCount(0);
  // Select a real rendered gutter rather than using a prototype-only jump UI.
  await page
    .locator('diffs-container [data-column-number="10"]')
    .last()
    .click();
  const line = page
    .getByText("// second.ts line 10 context", { exact: true })
    .first();
  await expect(line).toBeVisible();
  await pinnedHeader("second.ts");
  await expect
    .poll(async () => {
      const target = await line.boundingBox(),
        frame = await viewport.boundingBox();
      return (
        target != null &&
        target.y >= frame.y &&
        target.y < frame.y + frame.height
      );
    })
    .toBe(true);
  await page.getByRole("button", { name: "Add temporary comment" }).click();
  await page
    .getByRole("textbox", { name: "Temporary comment" })
    .fill("Keep this draft across layout changes");
  await page.keyboard.press("End");
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("textbox", { name: "Temporary comment" }),
  ).toHaveValue("Keep this draft across layout changes ");
  await page.getByRole("checkbox", { name: "Side by side" }).uncheck();
  await expect(diff).toHaveAttribute("data-diff-type", "single");
  await expect(
    page.getByRole("textbox", { name: "Temporary comment" }),
  ).toHaveValue("Keep this draft across layout changes ");
  await page.getByRole("checkbox", { name: "Wrap long lines" }).uncheck();
  await expect(diff).toHaveAttribute("data-overflow", "scroll");
  await page.getByRole("checkbox", { name: "Wrap long lines" }).check();
  for (const width of [1200, 600, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page
      .getByRole("combobox", { name: "Preview file" })
      .selectOption("0");
    await expect
      .poll(() => viewport.evaluate((e) => e.scrollWidth - e.clientWidth))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      )
      .toBeLessThanOrEqual(1);
    const toolbar = page.getByRole("checkbox", { name: "Wrap long lines" });
    const box = await toolbar.boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= width,
      "toolbar stays in viewport",
    );
  }
  assert.deepEqual(errors, []);
  await region.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Preview with Pierre" }),
  ).toBeFocused();
  console.log(
    "PASS: GitHub light/dark colors, custom sticky filenames, keyboard clipboard copy/selection suppression, header font metrics, scoped scroll shortcuts, editable spaces, background shortcut isolation, Escape/focus, wheel scrolling, file/gutter selection, live split/wrap updates, annotation draft across layout changes, and 1200/600/320px containment (real Pierre).",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
