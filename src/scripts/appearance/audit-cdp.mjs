#!/usr/bin/env node
// UI-only audit of an explicitly supplied, isolated authenticated Chrome.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseArgs } from "node:util";
const require = createRequire(import.meta.url);
const src = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    cdp: { type: "string", default: "http://127.0.0.1:9222" },
    output: {
      type: "string",
      default: join(src, ".local/dark-mode/cdp-audit"),
    },
    routes: { type: "string" },
    widths: { type: "string", default: "1440,390" },
    "ready-selector": { type: "string" },
  },
});
if (new URL(values.cdp).hostname !== "127.0.0.1")
  throw Error("Use a localhost-only SSH tunnel");
const { chromium } = require(
  require.resolve("playwright-core", {
    paths: [join(src, "packages/cli/node_modules")],
  }),
);
const axePath = require.resolve("axe-core/axe.min.js", { paths: [src] });
const routes = values.routes?.split(",") ?? [
  "/projects",
  "/hosts",
  "/hosts?tab=vms",
  "/notifications",
  "/settings/balance",
  "/settings/payment-methods",
  "/settings/usage-limits",
  "/admin/site-settings",
  "/admin/customers",
  "/admin/receivables",
  "/admin/membership-tiers",
];
if (routes.some((r) => !r.startsWith("/") || r.startsWith("//")))
  throw Error("Local routes only");
const widths = values.widths.split(",").map(Number);
if (widths.some((w) => !Number.isInteger(w) || w < 320))
  throw Error("Invalid widths");
await mkdir(values.output, { recursive: true });
const browser = await chromium.connectOverCDP(values.cdp);
const context = browser
  .contexts()
  .find((c) =>
    c.pages().some((p) => p.url().startsWith("https://lite2b.cocalc.ai/")),
  );
if (!context) throw Error("No signed-in lite2b context");
const page = await context.newPage();
page.setDefaultTimeout(12000);
const report = [];
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let original;
async function capture(name) {
  if (values["ready-selector"]) {
    await page.locator(values["ready-selector"]).first().waitFor({
      state: "visible",
      timeout: 45000,
    });
  }
  await page.waitForTimeout(4000);
  const bodyText = await page.locator("body").innerText();
  if (bodyText.trim().length < 160 || /^Connecting\.\.\.$/m.test(bodyText)) {
    throw Error("Page is blank or still connecting; not appearance evidence");
  }
  const row = {
    name,
    url: page.url(),
    screenshot: `${name}.png`,
    status: "unreviewed",
  };
  await page.screenshot({ path: join(values.output, row.screenshot) });
  await page.addScriptTag({ path: axePath });
  row.accessibility = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    return {
      violations: r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
      incomplete: r.incomplete.map((v) => ({
        id: v.id,
        nodes: v.nodes.length,
      })),
    };
  });
  row.errors = errors.splice(0);
  row.viewport = page.viewportSize();
  row.overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  report.push(row);
  await writeFile(
    join(values.output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `${name}: ${row.accessibility.violations.map((v) => v.id).join(", ") || "no automated violations"}`,
  );
}
try {
  await page.goto("https://lite2b.cocalc.ai/projects", {
    waitUntil: "domcontentloaded",
  });
  const appearance = page.getByRole("combobox", {
    name: "Appearance",
    exact: true,
  });
  original = await appearance.inputValue();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    for (const mode of ["light", "dark"]) {
      await appearance.selectOption(mode);
      for (const [i, route] of routes.entries()) {
        const name = `${width}-${mode}-${i}`;
        try {
          await page.goto(`https://lite2b.cocalc.ai${route}`, {
            waitUntil: "domcontentloaded",
          });
          await appearance.waitFor();
          if (
            new URL(page.url()).pathname !== new URL(route, page.url()).pathname
          )
            throw Error("Wrong route");
          await capture(name);
        } catch (e) {
          report.push({ name, route, status: "failed", error: e.message });
          await writeFile(
            join(values.output, "report.json"),
            JSON.stringify(report, null, 2),
          );
          console.log(`${name}: failed ${e.message}`);
        }
      }
    }
  }
} finally {
  if (original) {
    await page.goto("https://lite2b.cocalc.ai/projects", {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("combobox", { name: "Appearance", exact: true })
      .selectOption(original);
    await page.waitForTimeout(1000);
  }
  await page.close();
  // Disconnect without closing the user's browser.
  await browser.close();
}
if (report.some((r) => r.status === "failed")) process.exitCode = 1;
