// Render the real Scan dialog and keyboard boundary with a deterministic RPC
// fixture. This validates browser behavior, not a deployed hub or host.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { root, require, scanBrowserBundle } from "./manual-scan-bundle.mjs";
const { chromium } = require("@playwright/test");
const temp = await mkdtemp(join(tmpdir(), "manual-scan-browser-"));
const projects = Array.from({ length: 30 }, (_, i) => ({
  project_id: `project-${i}`,
  title: `Project ${i}`,
}));
let operation,
  enabled = true;
const starts = [];
let server, browser;
try {
  const bundle = await scanBrowserBundle(temp);
  const axe = await readFile(
    join(root, "node_modules/axe-core/axe.min.js"),
    "utf8",
  );
  server = createServer(async (req, res) => {
    if (req.url === "/app.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(bundle);
      return;
    }
    if (req.url === "/rpc") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      let result = { enabled, operation };
      if (input.action === "projects")
        result = {
          enabled,
          total: 30,
          projects: projects.slice(input.after ? 25 : 0, input.after ? 30 : 25),
          ...(input.after ? {} : { next: "page2" }),
        };
      if (input.action === "start") {
        starts.push(input);
        operation = {
          op_id: "operation",
          status: "running",
          cancelling: false,
          total: 30,
          processed: 0,
          counts: {},
          next_eligible_at: 0,
          children: projects.map((p) => ({
            ...p,
            request_id: p.project_id,
            state: "queued",
          })),
        };
        result = { enabled, operation };
      }
      if (input.action === "cancel") {
        operation.cancelling = true;
        result = { enabled, operation };
      }
      if (result.operation) {
        const children = result.operation.children;
        result = {
          ...result,
          operation: {
            ...result.operation,
            children: children.slice(
              input.after ? 25 : 0,
              input.after ? 30 : 25,
            ),
            ...(input.after ? { next: undefined } : { next: "page2" }),
          },
        };
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manual Scan browser fixture</title></head><body><main id="root"></main><script src="/app.js"></script></body></html>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  for (const dark of [false, true])
    for (const zoom of [1, 2]) {
      operation = undefined;
      enabled = true;
      starts.length = 0;
      const page = await browser.newPage({
        viewport: { width: 320 * zoom, height: 900 * zoom },
      });
      await page.goto(
        `http://127.0.0.1:${server.address().port}/${dark ? "?dark" : ""}`,
      );
      if (zoom === 2)
        await page.evaluate(() => {
          document.body.style.zoom = "2";
        });
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Scan projects" });
      await dialog.waitFor();
      const select = dialog.getByRole("checkbox", {
        name: "Select all eligible projects (30)",
      });
      await select.focus();
      await page.keyboard.press("Space");
      const start = dialog.getByRole("button", { name: "Start scan" });
      await start.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("status").filter({ hasText: "0 of 30" }).waitFor();
      assert.equal(starts.length, 1);
      assert.equal(starts[0].project_ids, "all");
      await page.reload();
      if (zoom === 2)
        await page.evaluate(() => {
          document.body.style.zoom = "2";
        });
      await page
        .getByRole("button", { name: "Scan projects", exact: true })
        .click();
      await page.getByRole("status").waitFor();
      assert.equal(starts.length, 1);
      enabled = false;
      await dialog.getByRole("button", { name: "Refresh scan status" }).click();
      await page.getByText(/New scans are disabled/).waitFor();
      const cancel = dialog.getByRole("button", { name: "Cancel scan" });
      await cancel.focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("status")
        .filter({ hasText: "Cancelling" })
        .waitFor();
      assert.equal(await start.isDisabled(), true);
      await page.addScriptTag({ content: axe });
      const audit = await page.evaluate(
        async () =>
          await window.axe.run(document.querySelector('[role="dialog"]'), {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          }),
      );
      assert.deepEqual(
        audit.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
        [],
      );
      for (const name of [
        "Refresh scan status",
        "Cancel scan",
        "Next result page",
      ]) {
        const button = dialog.getByRole("button", { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        const rect = await button.boundingBox();
        assert(
          rect.x >= 0 && rect.x + rect.width <= 320 * zoom + 1,
          `${name} overflows`,
        );
      }
      // Partial outcomes retain their distinctions, paginate, and require an
      // explicit retry selection/start even after the earlier batch ends.
      operation = {
        ...operation,
        status: "failed",
        cancelling: false,
        processed: 30,
        counts: { successful: 25, unavailable: 2, truncated: 2, failed: 1 },
        children: projects.map((p, i) => ({
          ...p,
          request_id: p.project_id,
          state:
            i < 25
              ? "successful"
              : i < 27
                ? "unavailable"
                : i < 29
                  ? "truncated"
                  : "failed",
        })),
      };
      enabled = true;
      await dialog.getByRole("button", { name: "Refresh scan status" }).click();
      await page.getByRole("status").filter({ hasText: "30 of 30" }).waitFor();
      await dialog.getByRole("button", { name: "Next result page" }).click();
      await page.getByText("project-29: failed.", { exact: true }).waitFor();
      await dialog
        .getByRole("button", { name: "Select unsuccessful projects for retry" })
        .click();
      await page.getByText(/5 projects selected/).waitFor();
      assert.equal(starts.length, 1);
      await start.click();
      await page.getByRole("status").filter({ hasText: "0 of 30" }).waitFor();
      assert.equal(starts.length, 2);
      assert.deepEqual(
        starts[1].project_ids,
        projects.slice(25).map((p) => p.project_id),
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await page
          .getByRole("button", { name: "Scan projects", exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.close();
      process.stdout.write(
        `PASS ${dark ? "dark" : "light"}, ${zoom * 100}% zoom, 320 CSS px: keyboard, cancel, reload, partial results, explicit retry, focus, axe\n`,
      );
    }
} finally {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await rm(temp, { recursive: true, force: true });
}
