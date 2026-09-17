/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// Opt-in UI smoke. Attach to a human-authenticated dev browser; never read its
// cookies or credentials. Creates/closes only its own page and starts no turns.
const { createRequire } = require("node:module");
const path = require("node:path");
const req = createRequire(
  path.resolve(__dirname, "../../packages/frontend/package.json"),
);
const { chromium, expect } = req("@playwright/test");

function endpoint(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol) ||
    !/^\/projects\/[^/]+\/files\/.+\.chat$/.test(url.pathname)
  ) {
    throw Error("Use project .chat thread URLs without credentials.");
  }
  const thread = new URLSearchParams(url.hash.slice(1)).get("thread");
  if (!thread || thread.length > 200)
    throw Error("Thread URL needs #thread=ID");
  url.search = "";
  url.hash = `thread=${encodeURIComponent(thread)}`;
  return { url, thread };
}

async function main() {
  if (process.env.COCALC_AGENT_MESSAGING_SMOKE !== "1") {
    throw Error(
      "Set COCALC_AGENT_MESSAGING_SMOKE=1 to enable this live smoke.",
    );
  }
  const alpha = endpoint(process.env.COCALC_AGENT_THREAD_URL_A);
  const beta = endpoint(process.env.COCALC_AGENT_THREAD_URL_B);
  if (
    alpha.url.origin !== beta.url.origin ||
    alpha.url.pathname !== beta.url.pathname ||
    alpha.thread === beta.thread
  ) {
    throw Error("Provide two distinct Codex threads in the same chat file.");
  }
  const browser = await chromium.connectOverCDP(
    process.env.COCALC_BROWSER_CDP_URL ?? "http://localhost:9222",
  );
  let page;
  try {
    page = await browser.contexts()[0].newPage();
    page.setDefaultTimeout(30000);
    async function check(stage, target) {
      const settings = page.getByRole("button", { name: "Codex", exact: true });
      await settings.click();
      await expect(
        page.getByRole("textbox", { name: "Thread ID", exact: true }),
      ).toHaveValue(target.thread, { timeout: 10000 });
      await expect(page).toHaveURL(target.url.href);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      console.log(
        JSON.stringify({ stage, thread_id: target.thread, ok: true }),
      );
    }
    await page.goto(alpha.url.href, { waitUntil: "domcontentloaded" });
    await check("cold-load", alpha);
    await page.goto(beta.url.href, { waitUntil: "domcontentloaded" });
    await check("already-open", beta);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await check("back", alpha);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await check("forward", beta);
    await page.reload({ waitUntil: "domcontentloaded" });
    await check("refresh", beta);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await check("back-after-refresh", alpha);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await check("forward-after-refresh", beta);
  } finally {
    await page?.close().catch(() => {});
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
