#!/usr/bin/env node
// Operates only the explicitly supplied dedicated browser via typed CLI actions.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify, parseArgs } from "node:util";
import { assertCapturedRoute } from "./route-check.mjs";

const exec = promisify(execFile);
const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    api: { type: "string" },
    browser: { type: "string" },
    project: { type: "string" },
    "base-url": { type: "string", default: "https://lite2b.cocalc.ai" },
    output: { type: "string", default: ".local/dark-mode/signed-in-audit" },
    routes: { type: "string" },
    widths: { type: "string", default: "1440,390" },
    "restore-mode": { type: "string", default: "light" },
  },
});
for (const key of ["profile", "api", "browser", "project"])
  if (!values[key]) throw Error(`--${key} is required`);
if (!["system", "light", "dark"].includes(values["restore-mode"]))
  throw Error("Invalid restore mode");
const widths = values.widths.split(",").map(Number);
if (widths.some((w) => !Number.isInteger(w) || w < 320))
  throw Error("Invalid widths");
const routes = values.routes?.split(",") ?? [
  "/projects",
  "/settings/appearance",
  "/settings/profile",
  "/settings/membership",
  "/settings/editor",
  "/settings/communication",
  "/settings/security",
  "/settings/ai",
  "/settings/usage-limits",
  "/settings/public-shares",
  "/settings/support",
  "/notifications",
  "/admin",
  `/projects/${values.project}/settings`,
  `/projects/${values.project}/files/`,
  `/projects/${values.project}/apps`,
  `/projects/${values.project}/new`,
  "/static/ultralite.html#/projects",
  `/static/ultralite.html#/project/${values.project}/files?path=%2Fhome%2Fuser`,
];
if (routes.some((r) => !r.startsWith("/") || r.startsWith("//")))
  throw Error("Invalid routes");
const output = resolve(values.output);
await mkdir(output, { recursive: true });
let browser = values.browser;
const report = [];
async function cli(args) {
  const { stdout } = await exec(
    "/opt/cocalc/bin/node",
    [
      "/opt/cocalc/bin2/cocalc-cli.js",
      "--json",
      "--profile",
      values.profile,
      "--api",
      values.api,
      ...args,
    ],
    { timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
  );
  const response = JSON.parse(stdout);
  if (!response.ok)
    throw Error(response.error?.message ?? "CLI request failed");
  browser = response.data?.browser_id ?? browser;
  return response.data;
}
function target() {
  return ["--project-id", values.project, "--browser", browser];
}
async function setMode(mode) {
  const selector = await appearanceSelector();
  await cli(["browser", "action", "type", selector, mode, ...target()]);
}
async function appearanceSelector() {
  for (const selector of [
    'select[aria-label="Appearance"]',
    'select[aria-label="Color theme"]',
  ]) {
    try {
      await cli([
        "browser",
        "action",
        "wait-for-selector",
        selector,
        "--timeout",
        "5s",
        ...target(),
      ]);
      return selector;
    } catch {
      // Try the selector used by the other first-party frontend.
    }
  }
  throw Error("No appearance selector found");
}
try {
  // Client-side navigation retains old bundles after a static rebuild.
  await cli(["browser", "action", "reload", ...target()]);
  for (const width of widths)
    for (const mode of ["light", "dark"]) {
      for (const [index, route] of routes.entries()) {
        const row = { route, width, mode, status: "unreviewed" };
        report.push(row);
        try {
          await cli([
            "browser",
            "action",
            "navigate",
            new URL(route, values["base-url"]).href,
            ...target(),
          ]);
          await setMode(mode);
          // Let lazy route views and fonts settle without requiring network idle.
          await new Promise((r) => setTimeout(r, 2000));
          const screenshot = join(output, `${width}-${mode}-${index}.png`);
          const result = await cli([
            "browser",
            "screenshot",
            "--renderer",
            "native",
            "--fullpage",
            "--viewport-width",
            `${width}`,
            "--viewport-height",
            "950",
            "--timeout",
            "25s",
            "--out",
            screenshot,
            ...target(),
          ]);
          row.screenshot = screenshot;
          row.actualUrl = result.page_url;
          assertCapturedRoute(
            new URL(route, values["base-url"]).href,
            result.page_url,
          );
        } catch (error) {
          row.status = "capture-failed";
          row.error = error.message;
        }
        await writeFile(
          join(output, "report.json"),
          JSON.stringify(report, null, 2),
        );
        process.stdout.write(`${mode} ${width} ${route}: ${row.status}\n`);
      }
    }
} finally {
  // This preference is account-wide; do not leave a test mode behind.
  try {
    await setMode(values["restore-mode"]);
  } catch {
    process.stderr.write(
      "Could not restore appearance; restore it in the dedicated session.\n",
    );
    process.exitCode = 1;
  }
}
if (report.some((r) => r.status === "capture-failed")) process.exitCode = 1;
