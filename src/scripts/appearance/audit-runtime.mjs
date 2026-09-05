#!/usr/bin/env node
// Isolated anonymous contexts only; no account credentials or project writes.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright-core", {
    paths: [join(src, "packages/cli/node_modules")],
  }),
);
const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "https://lite2b.cocalc.ai" },
    output: { type: "string", default: join(src, ".local/dark-mode/runtime") },
  },
});
await mkdir(values.output, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const report = [];
try {
  for (const route of ["/", "/docs/terminal/use-terminal"]) {
    for (const rate of [1, 4]) {
      const context = await browser.newContext({ colorScheme: "dark" });
      try {
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
        await page.goto(new URL(route, values["base-url"]).href);
        const select = page.getByRole("combobox", {
          name: "Appearance",
          exact: true,
        });
        await select.waitFor();
        const consent = page.getByRole("button", { name: /Necessary only/i });
        await page.waitForTimeout(1500);
        if (await consent.isVisible()) {
          await consent.click();
          await page.locator("#cc-main .cm").waitFor({ state: "hidden" });
        }
        await page.waitForFunction(
          () => document.documentElement.dataset.cocalcTheme === "dark",
        );
        await select.focus();
        // Measure from the native input event to a following rendered frame,
        // excluding Playwright/CLI/network round trips. Check style and focus too.
        const samples = await select.evaluate(async (element) => {
          const results = [];
          const frame = () =>
            new Promise((resolve) => requestAnimationFrame(resolve));
          for (let i = 0; i < 30; i++) {
            const mode = i % 2 ? "dark" : "light";
            const start = performance.now();
            element.value = mode;
            element.dispatchEvent(new Event("change", { bubbles: true }));
            await frame();
            await frame();
            if (document.documentElement.dataset.cocalcTheme !== mode)
              throw Error("Theme not applied");
            if (document.activeElement !== element)
              throw Error("Toggle lost focus");
            results.push(performance.now() - start);
          }
          return results;
        });
        const sorted = [...samples].sort((a, b) => a - b);
        const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
        report.push({
          route,
          rate,
          samples,
          p95,
          targetMs: rate === 1 ? 100 : null,
          passed: rate !== 1 || p95 < 100,
        });
        await select.selectOption("system");
        for (const colorScheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme });
          await page.waitForFunction(
            (mode) => document.documentElement.dataset.cocalcTheme === mode,
            colorScheme,
          );
          assert.equal(await select.inputValue(), "system");
        }
      } finally {
        await context.close();
      }
    }
    for (const blockedStorage of [false, true]) {
      const context = await browser.newContext({ colorScheme: "dark" });
      try {
        if (blockedStorage)
          await context.addInitScript(() => {
            Object.defineProperty(window, "localStorage", {
              get() {
                throw new Error("blocked");
              },
            });
          });
        const page = await context.newPage();
        // Leave inline prepaint enabled but prevent the app bundles from loading.
        await page.route("**/*", (request) =>
          request.request().resourceType() === "script"
            ? request.abort()
            : request.continue(),
        );
        await page.goto(new URL(route, values["base-url"]).href, {
          waitUntil: "domcontentloaded",
        });
        const theme = await page.evaluate(() => ({
          resolved: document.documentElement.dataset.cocalcTheme,
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
        }));
        assert.equal(theme.resolved, "dark");
        assert.equal(theme.colorScheme, "dark");
        report.push({ route, blockedStorage, prepaint: theme, passed: true });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await writeFile(
    join(values.output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
console.log(report.map(({ samples, ...row }) => row));
if (report.some((row) => !row.passed)) process.exitCode = 1;
