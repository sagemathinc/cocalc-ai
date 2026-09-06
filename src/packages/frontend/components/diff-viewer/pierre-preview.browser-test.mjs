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
      createRoot(document.getElementById('root')).render(<DiffPreviewButton getSource={() => ({kind:'patch',label:'Browser fixture',patch:${JSON.stringify(patch)}})} />);`,
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
              /^@cocalc\/frontend\/(keyboard\/boundary|chat\/git-commit\/review-editors)$/,
          },
          ({ path }) => ({ path, namespace: "stub" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          contents: path.endsWith("boundary")
            ? "export function KeyboardBoundary({children}) {return children}"
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
  await expect
    .poll(() => viewport.evaluate((e) => getComputedStyle(e).overflowY))
    .toBe("auto");
  const rect = await viewport.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 100);
  await page.mouse.wheel(0, 900);
  await expect
    .poll(() => viewport.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(500);
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
  await page.getByRole("spinbutton", { name: "Preview line" }).fill("190");
  await page.getByRole("spinbutton", { name: "Preview line" }).press("Enter");
  const line = page
    .getByText("// second.ts line 190 context", { exact: true })
    .first();
  await expect(line).toBeVisible();
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
  await page.getByRole("checkbox", { name: "Side by side" }).uncheck();
  await expect(diff).toHaveAttribute("data-diff-type", "single");
  await expect(
    page.getByRole("textbox", { name: "Temporary comment" }),
  ).toHaveValue("Keep this draft across layout changes");
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
  console.log(
    "PASS: wheel scrolling, file selection, line jump, live split/wrap updates, annotation draft across layout changes, and 1200/600/320px containment (real Pierre).",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
