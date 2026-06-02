#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const SRC_ROOT = resolve(new URL("../../", import.meta.url).pathname);

function usage(message) {
  if (message) {
    console.error(`[star-browser-smoke] ERROR: ${message}`);
  }
  console.error(`Usage:
  node scripts/star-poc/browser-smoke-star-poc.mjs \\
    --base-url http://127.0.0.1:9100 \\
    --project-id <uuid> \\
    --cookie-header 'account_id=...; remember_me=...'`);
  process.exit(message ? 1 : 0);
}

function takeValue(args, index, name) {
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) {
    usage(`${name} requires a value`);
  }
  return value;
}

function parseArgs() {
  const opts = {
    baseUrl: process.env.STAR_SMOKE_BROWSER_BASE_URL ?? process.env.STAR_API,
    projectId: process.env.STAR_SMOKE_PROJECT_ID,
    cookieHeader: process.env.STAR_SMOKE_COOKIE_HEADER,
    chromiumPath:
      process.env.STAR_SMOKE_CHROMIUM ??
      process.env.COCALC_CHROMIUM_BIN ??
      findExecutable([
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
      ]),
    timeoutMs: Number(process.env.STAR_SMOKE_BROWSER_TIMEOUT_MS ?? 60000),
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") usage();
    if (arg === "--base-url") opts.baseUrl = takeValue(args, i++, arg);
    else if (arg === "--project-id") opts.projectId = takeValue(args, i++, arg);
    else if (arg === "--cookie-header")
      opts.cookieHeader = takeValue(args, i++, arg);
    else if (arg === "--chromium")
      opts.chromiumPath = takeValue(args, i++, arg);
    else if (arg === "--timeout")
      opts.timeoutMs = Number(takeValue(args, i++, arg));
    else usage(`unknown argument: ${arg}`);
  }

  if (!opts.baseUrl) usage("--base-url or STAR_API is required");
  if (!opts.projectId) usage("--project-id is required");
  if (!opts.cookieHeader) usage("--cookie-header is required");
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    usage("--timeout must be a positive number of milliseconds");
  }
  if (!opts.chromiumPath || !existsSync(opts.chromiumPath)) {
    usage(
      "Chromium executable not found; pass --chromium or set STAR_SMOKE_CHROMIUM",
    );
  }

  opts.baseUrl = new URL(opts.baseUrl).origin;
  return opts;
}

function findExecutable(names) {
  for (const name of names) {
    const result = spawnSync("which", [name], {
      encoding: "utf8",
    });
    const path = result.stdout?.trim().split("\n")[0];
    if (path) return path;
  }
}

function loadPlaywrightCore() {
  const candidates = [
    "playwright-core",
    join(SRC_ROOT, "packages/cli/node_modules/playwright-core"),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next local install location.
    }
  }
  throw new Error(
    "Unable to load playwright-core. Run pnpm install in src or ensure packages/cli dependencies are installed.",
  );
}

function cookiesFromHeader(header, baseUrl) {
  const { hostname } = new URL(baseUrl);
  return header
    .split(/;\s*/)
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index <= 0) throw new Error(`invalid cookie entry: ${part}`);
      return {
        name: part.slice(0, index),
        value: part.slice(index + 1),
        domain: hostname,
        path: "/",
        httpOnly: false,
        secure: baseUrl.startsWith("https://"),
        sameSite: "Lax",
      };
    });
}

function fail(message, details) {
  console.error(`[star-browser-smoke] ERROR: ${message}`);
  if (details != null) {
    console.error(JSON.stringify(details, null, 2));
  }
  process.exit(1);
}

async function probe(page, opts, file, expectedContentType) {
  const initialUrl = `${opts.baseUrl}/projects/${opts.projectId}/files/home/user/star-smoke/${file}`;
  const responses = [];
  const handler = (response) => {
    const url = response.url();
    if (
      url.includes(opts.projectId) ||
      url.includes(file) ||
      url.includes("/files/")
    ) {
      responses.push({
        status: response.status(),
        url,
        contentType: response.headers()["content-type"] ?? "",
      });
    }
  };

  page.on("response", handler);
  const initialResponse = await page.goto(initialUrl, {
    waitUntil: "domcontentloaded",
    timeout: opts.timeoutMs,
  });
  await page.waitForTimeout(5000);
  page.off("response", handler);

  const doubledSegment = `/${opts.projectId}/${opts.projectId}/`;
  const doubled = responses.filter((entry) =>
    new URL(entry.url).pathname.includes(doubledSegment),
  );
  if (doubled.length > 0) {
    fail(`project id is doubled while loading ${file}`, {
      initialUrl,
      responses: doubled,
    });
  }

  const fileResponses = responses.filter((entry) => entry.url.includes(file));
  const okFileResponse = fileResponses.find(
    (entry) =>
      entry.status === 200 &&
      entry.contentType.toLowerCase().startsWith(expectedContentType),
  );
  if (!okFileResponse) {
    fail(`did not load ${file} with HTTP 200 and ${expectedContentType}`, {
      initialUrl,
      initialStatus: initialResponse?.status() ?? null,
      finalUrl: page.url(),
      title: await page.title().catch(() => ""),
      bodyText: (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 1000),
      responses,
    });
  }

  return {
    file,
    initialUrl,
    finalUrl: page.url(),
    response: okFileResponse,
  };
}

async function main() {
  const opts = parseArgs();
  const { chromium } = loadPlaywrightCore();
  const browser = await chromium.launch({
    executablePath: opts.chromiumPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext();
    await context.addCookies(
      cookiesFromHeader(opts.cookieHeader, opts.baseUrl),
    );
    const page = await context.newPage();
    const consoleLogs = [];
    page.on("console", (msg) =>
      consoleLogs.push({ type: msg.type(), text: msg.text() }),
    );
    page.on("pageerror", (err) =>
      consoleLogs.push({ type: "pageerror", text: String(err) }),
    );

    const jpeg = await probe(page, opts, "viewer-test.jpg", "image/jpeg");
    const pdf = await probe(page, opts, "viewer-test.pdf", "application/pdf");

    console.log(
      JSON.stringify(
        {
          ok: true,
          base_url: opts.baseUrl,
          project_id: opts.projectId,
          jpeg,
          pdf,
          console_logs: consoleLogs,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(String(err?.stack ?? err)));
