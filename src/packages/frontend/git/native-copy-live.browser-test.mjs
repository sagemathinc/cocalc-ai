// Native mouse selection and Ctrl+C in the real drawer, across virtual windows.
// Diagnostic probe: not yet a passed acceptance test on the forwarded browser.
// Overwrite the clipboard with a test marker before reading copied output.
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
const page = await browser.contexts()[0].newPage();
await page.setViewportSize({ width: 1600, height: 1000 });
const cdp = await page.context().newCDPSession(page);
let clipboardPermission;
try {
  await page.bringToFront();
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  clipboardPermission = await page.evaluate(
    async () =>
      (await navigator.permissions.query({ name: "clipboard-read" })).state,
  );
  await cdp.send("Browser.setPermission", {
    origin: url.origin,
    permission: { name: "clipboard-read" },
    setting: "granted",
  });
  const renderer = page.getByRole("combobox", {
    name: "Diff renderer",
    exact: true,
  });
  await expect(renderer).toBeVisible({ timeout: 60000 });
  await renderer.selectOption("pierre");
  const viewport = page.getByRole("region", { name: "Git diff", exact: true });
  await expect(viewport).toBeVisible();
  for (const top of [0, 1800, 4000, 0]) {
    const warning = page.getByRole("button", {
      name: "Dismiss stale frontend build warning",
    });
    if (await warning.isVisible()) await warning.click();
    await viewport.scrollIntoViewIfNeeded();
    await viewport.evaluate((node, top) => {
      window.getSelection()?.removeAllRanges();
      node.scrollTop = top;
    }, top);
    await page.waitForTimeout(600);
    const coordinates = await viewport.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const diagnostics = [];
      const samples = [];
      for (const host of node.querySelectorAll("diffs-container")) {
        for (const line of host.shadowRoot?.querySelectorAll(
          "[data-content] [data-line]",
        ) ?? []) {
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const text = walker.currentNode;
            if (samples.length < 4) {
              const r = document.createRange();
              r.selectNodeContents(text);
              samples.push({
                text: text.textContent.slice(0, 60),
                rect: r.getBoundingClientRect().toJSON(),
              });
            }
            if (text.textContent.length < 24) continue;
            const range = document.createRange();
            range.selectNodeContents(text);
            if (range.getClientRects().length !== 1) continue;
            const rect = range.getBoundingClientRect();
            if (rect.top < bounds.top + 100 || rect.bottom > bounds.bottom - 20)
              continue;
            const point = (offset) => {
              range.setStart(text, offset);
              range.collapse(true);
              const r = range.getBoundingClientRect();
              return { x: r.left + 0.1, y: r.top + r.height / 2 };
            };
            const start = point(2),
              end = point(20);
            if (diagnostics.length < 3)
              diagnostics.push({
                start,
                end,
                host: host.tagName,
                hit: document
                  .elementFromPoint(start.x, start.y)
                  ?.outerHTML.slice(0, 250),
              });
            if (
              ![start, end].every(
                (p) => document.elementFromPoint(p.x, p.y) === host,
              )
            )
              continue;
            return {
              start,
              end,
              expected: text.textContent.slice(2, 20),
            };
          }
        }
      }
      throw Error(
        "No visible source span suitable for native selection: " +
          JSON.stringify({
            bounds: bounds.toJSON(),
            diagnostics,
            samples,
            hosts: node.querySelectorAll("diffs-container").length,
          }),
      );
    });
    await page.mouse.move(coordinates.start.x, coordinates.start.y);
    await page.evaluate(() =>
      navigator.clipboard.writeText("CoCalc native-copy acceptance marker"),
    );
    await page.mouse.down();
    await page.mouse.move(coordinates.end.x, coordinates.end.y, { steps: 10 });
    await page.mouse.up();
    console.log(
      await viewport.evaluate((node) => {
        const a = [];
        for (let p = node; p; p = p.parentElement)
          a.push({
            tag: p.tagName,
            cls: p.className,
            select: getComputedStyle(p).userSelect,
          });
        return a;
      }),
    );
    console.log(
      await page.evaluate(({ start }) => {
        let el = document.elementFromPoint(start.x, start.y);
        const chain = [];
        while (el) {
          chain.push({
            tag: el.tagName,
            select: getComputedStyle(el).userSelect,
            text: el.textContent?.slice(0, 60),
          });
          const deep = el.shadowRoot?.elementFromPoint(start.x, start.y);
          if (!deep || deep === el) break;
          el = deep;
        }
        const s = window.getSelection();
        return {
          chain,
          selection: s?.toString(),
          anchor: s?.anchorNode?.nodeName,
          offset: s?.anchorOffset,
        };
      }, coordinates),
    );
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe(coordinates.expected);
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(coordinates.expected);
  }
  console.log(
    "Passed: native mouse-selected partial source copies exactly through Ctrl+C in four real virtual-scroll windows.",
  );
} finally {
  if (clipboardPermission)
    await cdp.send("Browser.setPermission", {
      origin: url.origin,
      permission: { name: "clipboard-read" },
      setting: clipboardPermission,
    });
  await page.close();
}
process.exit(0);
