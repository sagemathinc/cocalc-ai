// Isolated browser check of real Trees and first-party review controls.
// Run from the frontend package: node components/diff-viewer/navigation-layout.browser-test.mjs
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: {
    resolveDir: frontend,
    loader: "tsx",
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import ChangedFilesTree from './components/diff-viewer/changed-files-tree';
      import { ReviewFileHeader } from './components/diff-viewer/review-file-header';
      import { GitDiffFind } from './chat/git-commit/diff-find-control';
      import { REVIEW_VIEWPORT_HEIGHT } from './components/diff-viewer/review-viewport';
      function App() {
        const [query, setQuery] = useState('');
        const [selected, setSelected] = useState('');
        return <main style={{display:'grid',gridTemplateColumns:'260px minmax(0,1fr)',gap:12}}>
          <aside><ChangedFilesTree files={Array.from({length:100},(_,i)=>({id:String(i),path:'src/file'+String(i).padStart(3,'0')+'.ts'}))} onSelect={setSelected}/></aside>
          <section>
            <div role="group" aria-label="Diff controls" style={{display:'flex',alignItems:'center',gap:8}}>
              <button>Side by side</button>
              <GitDiffFind query={query} onChange={setQuery} inputRef={null} count={0} index={-1} onNext={()=>{}} onPrevious={()=>{}} />
            </div>
            <div data-code-viewport style={{height:REVIEW_VIEWPORT_HEIGHT}}>
              <ReviewFileHeader path={'directory/'.repeat(20)+'file.ts'} oldPath="old.ts" description="Pinned source revision" fontSize={14} onCopyPath={()=>{}} onViewRevision={()=>{}} onViewBefore={()=>{}} />
            </div>
            <output>{selected}</output>
          </section>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `,
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "isolated-app-context",
      setup(b) {
        b.onResolve(
          {
            filter:
              /^@cocalc\/frontend\/(appearance\/use-appearance|app-framework)$/,
          },
          ({ path }) => ({ path, namespace: "fixture" }),
        );
        b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents: path.endsWith("use-appearance")
            ? 'export const useAppearance=()=>({resolved: "light"});'
            : "export const redux={getActions:()=>({})};",
        }));
      },
    },
  ],
});
const server = createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/app.js" ? "text/javascript" : "text/html",
  );
  response.end(
    request.url === "/app.js"
      ? bundle.outputFiles[0].text
      : '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium-browser",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByText("100 changed files")).toBeVisible();
  const hint = page.getByRole("status", { name: "File tree scrolling" });
  await expect(hint).toHaveText("More files below");
  const aside = await page.locator("aside > div").boundingBox();
  const code = await page.locator("[data-code-viewport]").boundingBox();
  expect(Math.abs(aside.height - code.height)).toBeLessThan(2);
  const scroll = page.locator("[data-file-tree-virtualized-scroll]");
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(hint).toHaveText("More files above");
  const filter = page.getByRole("searchbox", { name: "Filter changed files" });
  await filter.fill("file099");
  await expect(hint).toHaveText("");
  await expect(page.getByText("100 changed files")).toBeVisible();
  await filter.clear();
  await scroll.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(hint).toHaveText("More files below");
  const path = page.getByRole("button", {
    name: /^Copy repository-relative path:/,
  });
  const primary = page.getByRole("button", { name: "View at this revision" });
  const header = page.locator("[data-review-file-header]");
  expect((await header.boundingBox()).height).toBe(37);
  const a = await path.boundingBox(),
    b = await primary.boundingBox();
  expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThan(2);
  expect(await path.getAttribute("title")).toContain("Pinned source revision");
  const toolbar = await page
    .getByRole("group", { name: "Diff controls" })
    .boundingBox();
  const find = await page
    .getByRole("search", { name: "Find in diff" })
    .boundingBox();
  expect(
    Math.abs(toolbar.x + toolbar.width - find.x - find.width),
  ).toBeLessThan(2);
  await page.setViewportSize({ width: 900, height: 650 });
  expect((await header.boundingBox()).height).toBe(37);
  await expect(primary).toBeVisible();
  await expect(hint).toHaveText("More files below");
  await page.setViewportSize({ width: 1400, height: 3600 });
  await expect(hint).toHaveText("");
  expect(errors).toEqual([]);
  console.log(
    "Passed real Trees overflow/filter/resize, total count, matching viewport heights, and single-row long-path headers.",
  );
} finally {
  await browser?.close();
  server.close();
}
