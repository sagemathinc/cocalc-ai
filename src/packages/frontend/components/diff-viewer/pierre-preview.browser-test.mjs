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
      import DocumentDiff from './components/diff-viewer/document-diff';
      import { ActivityDiff } from './chat/activity-diff';
      import ChangedFilesTree from './components/diff-viewer/changed-files-tree';
      import { DiffHighlightingProvider } from './components/diff-viewer/highlighting-provider';
      import { useWorkerPool } from '@pierre/diffs/react';
      import { getBrowserAppearanceStore } from '@cocalc/util/appearance-browser';
      window.chooseAppearance = (preference) => getBrowserAppearanceStore().choose(preference);
      function PoolProbe() {
        const pool = useWorkerPool();
        const [stats, setStats] = React.useState(() => pool.getStats());
        React.useEffect(() => pool.subscribeToStatChanges(setStats), [pool]);
        return <output aria-label="Worker pool status">{stats.managerState}</output>;
      }
      function Harness() {
        const [fontSize, setFontSize] = React.useState(14);
        const [revision, setRevision] = React.useState('new version');
        window.changeDocumentRevision = setRevision;
        window.previewSetFontSize = setFontSize;
        if (location.pathname === '/activity') return <ActivityDiff diff={{lines:[],types:[],gutters:[],chunkBoundaries:[],source:{kind:'unified',text:'@@ -10 +20 @@\\n-old activity\\n+'+revision+'\\n@@ -90 +100 @@\\n-last\\n+end\\n'}}} path='activity.ts' fontSize={14}><div>Classic activity</div></ActivityDiff>;
        if (location.pathname === '/documents') return <div style={{display:'flex',height:600,minWidth:0}}><DocumentDiff before={'old version\\n'+Array.from({length:5000},(_,i)=>'const n'+i+' = '+i+';\\n').join('')} after={revision+'\\n'+Array.from({length:5000},(_,i)=>'const n'+i+' = '+i+';\\n').join('')} path='history.ts' label='Selected historical versions' fontSize={fontSize}/></div>;
        const [files, setFiles] = React.useState([{id:'a',path:'src/a.ts',status:'added'}, {id:'b',path:'src/b.ts',status:'modified',commentCount:2}]);
        const [selected, setSelected] = React.useState('');
        const [consumers, setConsumers] = React.useState(2);
        window.setPoolConsumers = setConsumers;
        if (location.pathname === '/pool') return <>{Array.from({length:consumers},(_,i)=><DiffHighlightingProvider key={i}><PoolProbe/></DiffHighlightingProvider>)}</>;
        window.treeSetFiles = setFiles;
        if (location.pathname === '/tree') return <><ChangedFilesTree expansionScope={JSON.stringify(files.map(f=>f.path))} files={files} activeId={selected} onSelect={setSelected}/><output aria-label="Selected file">{selected}</output></>;
        window.previewSetFontSize = setFontSize;
        if (location.pathname === '/copy') return <DiffPreviewButton fontSize={14} getSource={() => (${JSON.stringify({ kind: "documents", path: "operators.ts", before: "+before;\n-before;\n", after: "+after;\n-after;\n", label: "Literal operators" })})} />;
        return <DiffPreviewButton fontSize={fontSize} getSource={() => ({kind:'patch',label:'Browser fixture',patch:${JSON.stringify(patch)}})} />;
      }
      createRoot(document.getElementById('root')).render(<Harness />);`,
    loader: "tsx",
  },
  bundle: true,
  outfile: "preview.js",
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
              /^@cocalc\/frontend\/components\/diff-viewer\/(document-diff|render-boundary)$/,
          },
          ({ path }) => ({
            path: `${frontend}components/diff-viewer/${path.split("/").at(-1)}.tsx`,
          }),
        );
        builder.onResolve({ filter: /\.\/highlighting-worker$/ }, () => ({
          path: "highlighting-worker",
          namespace: "stub",
        }));
        builder.onResolve(
          {
            filter:
              /^@cocalc\/frontend\/(app-framework|chat\/git-commit\/review-editors)$/,
          },
          ({ path }) => ({ path, namespace: "stub" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          contents:
            path === "highlighting-worker"
              ? "export function createHighlightingWorker() { return new Worker('/highlight-worker.js', {type:'module'}); }"
              : path.endsWith("app-framework")
                ? "export const redux = {getActions: () => undefined}"
                : "export function MarkdownHistoryInput({value,onChange}) {return <textarea aria-label='Temporary comment' value={value} onChange={e=>onChange(e.target.value)}/>}",
          loader: "tsx",
          resolveDir: frontend,
        }));
      },
    },
  ],
});
const workerBuilt = await build({
  absWorkingDir: frontend,
  entryPoints: ["node_modules/@pierre/diffs/dist/worker/worker.js"],
  bundle: true,
  write: false,
  format: "esm",
  define: { "process.env.NODE_ENV": '"development"' },
});
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/app.js" || req.url === "/highlight-worker.js"
      ? "application/javascript"
      : req.url === "/app.css"
        ? "text/css"
        : "text/html",
  );
  res.end(
    req.url === "/highlight-worker.js"
      ? workerBuilt.outputFiles[0].contents
      : req.url === "/app.js"
        ? built.outputFiles.find((file) => file.path.endsWith(".js")).contents
        : req.url === "/app.css"
          ? built.outputFiles.find((file) => file.path.endsWith(".css"))
              .contents
          : '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
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
  if (!process.env.TREE_ONLY) {
    await page.goto(`http://127.0.0.1:${server.address().port}/activity`);
    await page
      .getByRole("combobox", { name: "Activity diff renderer" })
      .selectOption("pierre");
    const activityRegion = page.getByRole("region", {
      name: "activity.ts: recorded activity change (not a Git revision)",
    });
    await expect(
      activityRegion.getByText("new version", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("note")).toContainText(
      "omitted context is unavailable",
    );
    await page.evaluate(() =>
      window.changeDocumentRevision("next streamed value"),
    );
    await expect(
      activityRegion.getByText("next streamed value", { exact: true }),
    ).toBeVisible();
    await expect(
      activityRegion.getByText("new version", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "Activity diff renderer" })
      .selectOption("classic");
    await expect(page.getByText("Classic activity")).toBeVisible();
    await page.goto(`http://127.0.0.1:${server.address().port}/documents`);
    const documentRegion = page.getByRole("region", {
      name: "Selected historical versions",
    });
    await expect(documentRegion).toBeVisible();
    await expect(
      documentRegion.getByText("new version", { exact: true }),
    ).toBeVisible();
    await documentRegion.focus();
    await page.keyboard.press("Space");
    await expect
      .poll(() => documentRegion.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(100);
    await page.keyboard.press("Home");
    await page.evaluate(() =>
      window.changeDocumentRevision("changed historical version"),
    );
    await expect(
      documentRegion.getByText("changed historical version", { exact: true }),
    ).toBeVisible();
    await expect(
      documentRegion.getByText("new version", { exact: true }),
    ).toHaveCount(0);
    const documentCode = documentRegion.locator("pre[data-diff-type]").first();
    await page.evaluate(() => window.previewSetFontSize(20));
    await expect
      .poll(() =>
        documentCode.evaluate((element) => getComputedStyle(element).fontSize),
      )
      .toBe("20px");
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => window.chooseAppearance("dark"));
    await expect
      .poll(() =>
        documentCode.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        ),
      )
      .toBe("rgb(36, 41, 46)");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => window.chooseAppearance("light"));
    await expect
      .poll(() =>
        documentCode.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        ),
      )
      .toBe("rgb(255, 255, 255)");
    await page.evaluate(() => window.chooseAppearance("system"));
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("checkbox", { name: "Side by side" }).check();
    await expect(
      documentRegion.locator('[data-diff-type="split"]').first(),
    ).toBeVisible();
    for (const width of [1200, 600, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
    }
    await page.getByRole("checkbox", { name: "Side by side" }).uncheck();
    await page.evaluate(() => window.changeDocumentRevision("old version"));
    await expect(
      documentRegion.getByText("old version", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}/pool`);
    await expect(page.getByLabel("Worker pool status").first()).toHaveText(
      "initialized",
    );
    await expect.poll(() => page.workers().length).toBe(2);
    await page.evaluate(() => window.setPoolConsumers(1));
    await expect(page.getByLabel("Worker pool status")).toHaveCount(1);
    expect(page.workers().length).toBe(2);
    await page.evaluate(() => window.setPoolConsumers(0));
    await expect.poll(() => page.workers().length).toBe(0);
    await page.evaluate(() => window.setPoolConsumers(2));
    await expect(page.getByLabel("Worker pool status").first()).toHaveText(
      "initialized",
    );
    await expect.poll(() => page.workers().length).toBe(2);
  }
  await page.goto(`http://127.0.0.1:${server.address().port}/tree`);
  const folder = page.getByRole("treeitem", { name: /^src/ });
  await folder.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem(
          'cocalc:review-tree-expansion:v1:["src/a.ts","src/b.ts"]',
        ),
      ),
    )
    .toBe("[]");
  await page.reload();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await folder.focus();
  await page.keyboard.press("ArrowRight");
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  const b = page.getByRole("treeitem", { name: /b.ts/ });
  await expect(b).toBeVisible();
  await b.click();
  await expect(page.getByLabel("Selected file")).toHaveText("b");
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => window.chooseAppearance("dark"));
  await expect(page.locator("file-tree-container")).toHaveCSS(
    "color-scheme",
    "dark",
  );
  await expect(page.getByLabel("Selected file")).toHaveText("b");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => window.chooseAppearance("light"));
  await expect(page.locator("file-tree-container")).toHaveCSS(
    "color-scheme",
    "light",
  );
  await page.evaluate(() => window.chooseAppearance("system"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Selected file")).toHaveText("a");
  await page
    .getByRole("searchbox", { name: "Filter changed files" })
    .fill("b.ts");
  await expect(page.getByRole("treeitem", { name: /a.ts/ })).toHaveCount(0);
  await page.evaluate(() =>
    window.treeSetFiles([
      { id: "c", path: "other/c.ts", status: "deleted", commentCount: 3 },
    ]),
  );
  await page.getByRole("searchbox", { name: "Filter changed files" }).fill("");
  await expect(page.getByRole("treeitem", { name: /b.ts/ })).toHaveCount(0);
  const c = page.getByRole("treeitem", { name: /c.ts/ });
  await expect(c).toBeVisible();
  await c.click();
  await expect(page.getByLabel("Selected file")).toHaveText("c");
  await page.evaluate(() =>
    window.treeSetFiles([
      { id: "c", path: "other/c.ts", status: "deleted", commentCount: 7 },
    ]),
  );
  await expect(
    page.getByText("deleted; 7 comments", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.treeSetFiles([]));
  await expect(page.getByRole("treeitem")).toHaveCount(0);
  await page.evaluate(() =>
    window.treeSetFiles(
      Array.from({ length: 10000 }, (_, i) => ({
        id: String(i),
        path: "src/file-" + String(i).padStart(5, "0") + ".ts",
      })),
    ),
  );
  await expect(page.getByRole("treeitem").first()).toBeVisible();
  assert.ok(
    (await page.getByRole("treeitem").count()) < 200,
    "large tree remains virtualized",
  );
  await page
    .getByRole("searchbox", { name: "Filter changed files" })
    .fill("file-09999.ts");
  await page.getByRole("treeitem", { name: /file-09999.ts/ }).click();
  await expect(page.getByLabel("Selected file")).toHaveText("9999");
  await page.goto(`http://127.0.0.1:${server.address().port}/copy`);
  await page.getByRole("button", { name: "Preview with Pierre" }).click();
  await page.getByRole("checkbox", { name: "Side by side" }).check();
  for (const [side, expected] of [
    ["deletions", "+before;\n-before;"],
    ["additions", "+after;\n-after;"],
  ]) {
    const content = page.locator(
      `diffs-container code[data-${side}] [data-content]`,
    );
    await expect(content).toBeVisible();
    await page.getByRole("region", { name: "Diff preview" }).focus();
    await content.evaluate((node) => {
      const lines = node.querySelectorAll("[data-line]");
      const first = lines[0],
        last = lines[lines.length - 1];
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.childNodes.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press("Control+c");
    assert.equal(
      (await page.evaluate(() => navigator.clipboard.readText())).trimEnd(),
      expected,
      `${side}: native copying preserves literal operators without diff markers or gutters`,
    );
  }
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "Preview with Pierre" }).click();
  await expect.poll(() => page.workers().length).toBe(2);
  await page.getByRole("combobox", { name: "Preview file" }).waitFor();
  const viewport = page.locator(".cocalc-pierre-preview-viewport");
  const treeNavigation = page.getByRole("complementary", {
    name: "Changed-file navigation",
  });
  await expect(
    treeNavigation.getByRole("treeitem", { name: /second.ts/ }),
  ).toBeVisible();
  await treeNavigation.getByRole("treeitem", { name: /second.ts/ }).click();
  await expect(
    page.getByRole("combobox", { name: "Preview file" }),
  ).toHaveValue("1");
  await page.getByRole("combobox", { name: "Preview file" }).selectOption("0");
  const diff = page.locator("diffs-container pre[data-diff]").first();
  // The earlier scenario chose split view; reopening must retain that choice.
  await expect(diff).toHaveAttribute("data-diff-type", "split");
  await page.getByRole("checkbox", { name: "Side by side" }).uncheck();
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
  await page.evaluate(() => window.chooseAppearance("dark"));
  await expect
    .poll(() => diff.evaluate((e) => getComputedStyle(e).backgroundColor))
    .toBe("rgb(36, 41, 46)");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => window.chooseAppearance("light"));
  await expect
    .poll(() => diff.evaluate((e) => getComputedStyle(e).backgroundColor))
    .toBe("rgb(255, 255, 255)");
  await page.evaluate(() => window.chooseAppearance("system"));
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
    if (width < 800) await expect(treeNavigation).toBeHidden();
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
  await expect.poll(() => page.workers().length).toBe(0);
  await expect(
    page.getByRole("button", { name: "Preview with Pierre" }),
  ).toBeFocused();
  await page.route("**/highlight-worker.js", (route) => route.abort());
  await page.getByRole("button", { name: "Preview with Pierre" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Background diff highlighting is unavailable" }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByRole("button", {
      name: "Copy repository-relative path: first.ts",
      exact: true,
    }),
  ).toBeVisible();
  await expect.poll(() => page.workers().length).toBe(0);
  await region.focus();
  await expect(
    page.getByText("const value = 2;", { exact: true }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: GitHub light/dark colors, custom sticky filenames, keyboard clipboard copy/selection suppression, header font metrics, scoped scroll shortcuts, editable spaces, background shortcut isolation, Escape/focus, wheel scrolling, file/gutter selection, live split/wrap updates, annotation draft across layout changes, and 1200/600/320px containment (real Pierre).",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
