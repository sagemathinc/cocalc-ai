// Launched by scan-browser.acceptance.test.ts with its isolated, account-bound
// loopback bridge. Real Scan RPCs run through the home/owner/host fabric.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { require, scanBrowserBundle } from "./manual-scan-bundle.mjs";
const { chromium, expect } = require("@playwright/test");
const [bridgeUrl, availableId, unavailableId] = process.argv.slice(2);
const target = new URL(bridgeUrl);
assert.equal(target.hostname, "127.0.0.1");
const temp = await mkdtemp(join(tmpdir(), "scan-service-browser-"));
let server, browser;
const calls = [];
const errors = [];
try {
  const bundle = await scanBrowserBundle(temp);
  server = createServer(async (req, res) => {
    try {
      if (req.url === "/app.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(bundle);
      } else if (req.url === "/rpc" || req.url === "/rpc/second") {
        let body = "";
        for await (const chunk of req) body += chunk;
        calls.push({ actor: req.url, input: JSON.parse(body) });
        const reply = await fetch(new URL(req.url, target), {
          method: "POST",
          body,
        });
        res.statusCode = reply.status;
        res.setHeader("Content-Type", "application/json");
        res.end(await reply.text());
      } else {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scan service acceptance</title></head><body><main id="root"></main><script src="/app.js"></script></body></html>',
        );
      }
    } catch (err) {
      errors.push(String(err));
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Fixture RPC failed" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Scan projects" });
  await dialog.waitFor();
  const search = page.getByRole("textbox", { name: "Search projects" });
  await search.fill("Unavailable storage");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "Unavailable storage", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: "Available storage", exact: true }),
  ).toHaveCount(0);
  await search.fill("");
  await dialog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "Available storage", exact: true }),
  ).toBeVisible();
  const all = dialog.getByRole("checkbox", {
    name: "Select all eligible projects (2)",
  });
  await all.focus();
  await page.keyboard.press("Space");
  const start = dialog.getByRole("button", { name: "Start scan", exact: true });
  await start.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("2 of 2", {
    timeout: 90000,
  });
  await expect(
    dialog.getByRole("list", { name: "Project scan results" }),
  ).toContainText(`${availableId}: successful`);
  await expect(
    dialog.getByRole("list", { name: "Project scan results" }),
  ).toContainText(`${unavailableId}: unavailable`);
  await page.reload();
  await page
    .getByRole("button", { name: "Scan projects", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("2 of 2");
  assert.equal(calls.filter((c) => c.input.action === "start").length, 1);
  await dialog
    .getByRole("button", { name: "Select unsuccessful projects for retry" })
    .click();
  await expect(dialog.getByText(/1 projects selected/)).toBeVisible();
  // Wait for the actual durable account cooldown; no clocks or DB deadlines are changed.
  await expect(start).toBeEnabled({ timeout: 75000 });
  await start.click();
  await expect(page.getByRole("status")).toContainText("1 of 1", {
    timeout: 60000,
  });
  // Unreachable storage still spends project admission. Retrying after the
  // account interval must respect the longer project cooldown.
  await expect(
    dialog.getByRole("list", { name: "Project scan results" }),
  ).toContainText(`${unavailableId}: deferred`);
  const firstStarts = calls.filter(
    (c) => c.actor === "/rpc" && c.input.action === "start",
  );
  assert.equal(firstStarts.length, 2);
  assert.equal(firstStarts[0].input.project_ids, "all");
  assert.deepEqual(firstStarts[1].input.project_ids, [unavailableId]);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Scan projects", exact: true }),
  ).toBeFocused();

  // The second authenticated human has an independent home-bay worker. Hold
  // that worker until Cancel has durably arrived, then use normal recovery.
  await page.goto(`${url}/?actor=second`);
  await page
    .getByRole("button", { name: "Scan projects", exact: true })
    .click();
  await dialog
    .getByRole("checkbox", { name: "Available storage", exact: true })
    .check();
  await start.click();
  await expect(page.getByRole("status")).toContainText("0 of 1");
  const cancel = dialog.getByRole("button", { name: "Cancel scan" });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("1 of 1", {
    timeout: 60000,
  });
  await expect(
    dialog.getByRole("list", { name: "Project scan results" }),
  ).toContainText(`${availableId}: cancelled`);
  await page.reload();
  await page
    .getByRole("button", { name: "Scan projects", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("1 of 1");
  assert.equal(
    calls.filter((c) => c.actor === "/rpc/second" && c.input.action === "start")
      .length,
    1,
  );
  assert.deepEqual(errors, []);
  process.stdout.write(
    JSON.stringify({
      passed: true,
      starts: firstStarts.map((c) => c.input.project_ids),
      cancelled: true,
      reloaded: true,
    }) + "\n",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await rm(temp, { recursive: true, force: true });
}
