#!/usr/bin/env node
// Anonymous-only: never reads account cookies or writes to an account/project.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "https://lite2b.cocalc.ai" },
    output: {
      type: "string",
      default: join(src, ".local/dark-mode/public-audit"),
    },
    chromium: { type: "string", default: "/usr/bin/chromium" },
    routes: { type: "string" },
    widths: { type: "string", default: "1440,320" },
    "no-fail": { type: "boolean", default: false },
  },
});
const routes = values.routes?.split(",") ?? [
  "/",
  "/features",
  "/features/python",
  "/features/jupyter-notebook",
  "/docs",
  "/docs/terminal/use-terminal",
  "/pricing",
  "/about",
  "/guides",
  "/products",
  "/policies",
  "/support",
  "/news",
  "/rootfs",
  "/auth/sign-in",
];
const widths = values.widths.split(",").map(Number);
if (widths.some((width) => !Number.isFinite(width) || width < 1))
  throw Error("Invalid widths");
if (routes.some((route) => !route.startsWith("/") || route.startsWith("//")))
  throw Error("Routes must be local absolute paths");
const { chromium } = require(
  require.resolve("playwright-core", {
    paths: [join(src, "packages/cli/node_modules")],
  }),
);
const axe = require.resolve("axe-core/axe.min.js", { paths: [src] });
await mkdir(values.output, { recursive: true });
const browser = await chromium.launch({
  executablePath: values.chromium,
  args: ["--no-sandbox"],
});
const report = [];
try {
  for (const width of widths) {
    for (const mode of ["light", "dark"]) {
      const context = await browser.newContext({
        colorScheme: mode,
        viewport: { width, height: 950 },
      });
      try {
        const page = await context.newPage();
        let exceptions = [];
        page.on("pageerror", (error) => exceptions.push(error.message));
        for (const [index, route] of routes.entries()) {
          exceptions = [];
          const id = `${width}-${mode}-${index}`;
          const result = { route, width, mode };
          report.push(result);
          try {
            await page.goto(new URL(route, values["base-url"]).href, {
              waitUntil: "networkidle",
            });
            await page.locator(".cocalc-public-page").waitFor();
            await page.addScriptTag({ path: axe });
            const consent = page.getByRole("button", {
              name: /Necessary only/i,
            });
            if (await consent.isVisible()) {
              await page.waitForFunction(() => {
                const dialog = document.querySelector("#cc-main .cm");
                return dialog && getComputedStyle(dialog).opacity === "1";
              });
              result.consentViolations = await page.evaluate(async () => {
                const audit = await window.axe.run("#cc-main", {
                  runOnly: {
                    type: "tag",
                    values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
                  },
                });
                return audit.violations.map(({ id, nodes }) => ({
                  id,
                  nodes: nodes.map(({ target, failureSummary }) => ({
                    target,
                    failureSummary,
                  })),
                }));
              });
              await page.screenshot({
                path: join(values.output, `${id}-consent.png`),
                fullPage: true,
              });
              await consent.click();
              // The button loses its accessible role immediately, while the
              // containing dialog remains visible during its closing transition.
              await page.locator("#cc-main .cm").waitFor({ state: "hidden" });
            }
            Object.assign(
              result,
              await page.evaluate(async () => {
                const audit = await window.axe.run(document, {
                  runOnly: {
                    type: "tag",
                    values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
                  },
                });
                return {
                  resolved: document.documentElement.dataset.cocalcTheme,
                  overflow:
                    document.documentElement.scrollWidth > innerWidth + 1,
                  violations: audit.violations.map(({ id, impact, nodes }) => ({
                    id,
                    impact,
                    nodes: nodes.map(({ target, failureSummary }) => ({
                      target,
                      failureSummary,
                    })),
                  })),
                };
              }),
            );
            result.exceptions = [...exceptions];
            await page.screenshot({
              path: join(values.output, `${id}.png`),
              fullPage: true,
            });
            if (index === 0 && width >= 1000) {
              const select = page
                .getByRole("combobox", { name: "Appearance", exact: true })
                .first();
              await select.selectOption(mode === "dark" ? "light" : "dark");
              result.explicitToggle = await page
                .locator("html")
                .getAttribute("data-cocalc-theme");
              await select.selectOption("system");
              await page.emulateMedia({
                colorScheme: mode === "dark" ? "light" : "dark",
              });
              await page.waitForFunction(
                (expected) =>
                  document.documentElement.dataset.cocalcTheme === expected,
                mode === "dark" ? "light" : "dark",
              );
              result.systemChange = true;
              await page.emulateMedia({ colorScheme: mode });
            }
          } catch (error) {
            result.error = String(error);
          }
          process.stdout.write(
            `${id} ${route}: ${result.error || `${result.violations?.length ?? 0} violations; overflow=${result.overflow}`}\n`,
          );
          await writeFile(
            join(values.output, "report.json"),
            JSON.stringify(report, null, 2),
          );
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
if (
  !values["no-fail"] &&
  report.some(
    (item) =>
      item.error ||
      item.resolved !== item.mode ||
      item.overflow ||
      item.exceptions?.length ||
      item.consentViolations?.length ||
      item.violations?.length,
  )
)
  process.exitCode = 1;
