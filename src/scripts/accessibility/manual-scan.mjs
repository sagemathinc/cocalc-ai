// Render the real Scan Files tab and keyboard boundary with a deterministic RPC
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
  host_id: "fixture-host",
  title: `Project ${i}`,
  changed_since_scan: i === 0 || i === 29,
}));
let operation,
  enabled = true;
const starts = [];
let server, context;
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
          op_id: "a44e3f9e-6496-4269-a9fd-5fcb898b5f78",
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
  for (const dark of [false, true])
    for (const zoom of [1, 2]) {
      operation = undefined;
      enabled = true;
      starts.length = 0;
      context = await chromium.launchPersistentContext(
        join(temp, `profile-${dark}-${zoom}`),
        {
          executablePath: process.env.CHROME_BIN ?? "/usr/bin/chromium",
          headless: true,
          args: ["--no-sandbox", "--force-device-scale-factor=1"],
          viewport: { width: 320 * zoom, height: 900 * zoom },
        },
      );
      const page = await context.newPage();
      await page.goto(
        `http://127.0.0.1:${server.address().port}/${dark ? "?dark" : ""}`,
      );
      // Use Chromium's actual browser zoom in this disposable profile. CSS
      // zoom enlarges content without exercising the browser's reflow viewport.
      const settings = await context.newPage();
      await settings.goto("chrome://settings/appearance");
      await settings.evaluate(
        (factor) =>
          new Promise((resolve) =>
            chrome.settingsPrivate.setDefaultZoom(factor, resolve),
          ),
        zoom,
      );
      await settings.close();
      await page.bringToFront();
      assert.deepEqual(
        await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          scale: devicePixelRatio,
          cssZoom: getComputedStyle(document.body).zoom,
        })),
        {
          width: 320,
          height: 900,
          scale: zoom,
          cssZoom: "1",
        },
      );
      await page.keyboard.press("Tab");
      await page.keyboard.press("End");
      const dialog = page.getByRole("tabpanel", { name: "Scan Files" });
      await dialog.waitFor();
      const select = dialog.getByRole("checkbox", {
        name: "Select all eligible projects (30)",
      });
      await page.waitForFunction(
        () =>
          !document.querySelector(
            'input[aria-label="Select all eligible projects (30)"]',
          )?.disabled,
      );
      const picker = dialog.getByRole("group", { name: "Projects to scan" });
      const first = picker.getByRole("checkbox", {
        name: "Project 0",
        exact: true,
      });
      await first.focus();
      await page.keyboard.press("Space");
      await picker
        .getByRole("checkbox", { name: "Project 3", exact: true })
        .click({ modifiers: ["Shift"] });
      assert.equal(
        await picker
          .getByRole("checkbox", { name: "Project 2", exact: true })
          .isChecked(),
        true,
      );
      await page.keyboard.press("End");
      await picker
        .getByRole("checkbox", { name: "Project 29", exact: true })
        .waitFor();
      await page.waitForFunction(
        () =>
          document.activeElement?.closest("[data-checkbox-index]")?.dataset
            .checkboxIndex === "29",
      );
      await page.keyboard.press("Home");
      await page.waitForFunction(
        () =>
          document.activeElement?.closest("[data-checkbox-index]")?.dataset
            .checkboxIndex === "0",
      );
      const filter = dialog.getByRole("textbox", { name: "Search projects" });
      await filter.fill("Project 29");
      await picker
        .getByRole("checkbox", { name: "Project 0", exact: true })
        .waitFor({ state: "hidden" });
      assert.equal(
        await picker
          .getByRole("checkbox", { name: "Project 29", exact: true })
          .count(),
        1,
      );
      await dialog
        .getByRole("button", { name: "Changed since last scan (2)" })
        .click();
      await filter.fill("");
      await picker
        .getByRole("checkbox", { name: "Project 0", exact: true })
        .waitFor();
      await select.focus();
      await page.keyboard.press("Space");
      const start = dialog.getByRole("button", { name: "Start scan" });
      await start.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("status").filter({ hasText: "0 of 30" }).waitFor();
      assert.equal(starts.length, 1);
      assert.deepEqual(
        starts[0].project_ids,
        projects.map((p) => p.project_id),
      );
      await page.reload();
      assert.equal(await page.evaluate(() => innerWidth), 320);
      await page.getByRole("tab", { name: "Scan Files", exact: true }).click();
      await page.getByRole("status").waitFor();
      assert.equal(starts.length, 1);
      enabled = false;
      await dialog.getByRole("button", { name: "Refresh scan status" }).click();
      await page.getByText(/New scans are disabled/).waitFor();
      const cancel = dialog.getByRole("button", { name: "Cancel scan" });
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("button")].find(
            (b) => b.textContent.trim() === "Cancel scan",
          )?.disabled === false,
      );
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
          await window.axe.run(document.querySelector("main"), {
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
      const details = dialog.getByText("Scan details", { exact: true });
      await details.focus();
      await page.keyboard.press("Enter");
      assert.equal(await dialog.locator("details").getAttribute("open"), "");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      for (const name of [
        "Refresh scan status",
        "Cancel scan",
        "Next result page",
      ]) {
        const button = dialog.getByRole("button", { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        const rect = await button.boundingBox();
        assert(rect.x >= 0 && rect.x + rect.width <= 321, `${name} overflows`);
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
      await page
        .getByRole("status")
        .filter({ hasText: "27 of 30 projects scanned" })
        .waitFor();
      await dialog.getByRole("button", { name: "Next result page" }).click();
      await dialog
        .getByRole("list", { name: "Project scan results" })
        .getByText("Failed", { exact: true })
        .waitFor();
      await dialog
        .getByRole("button", { name: "Select unsuccessful projects for retry" })
        .click();
      await page.getByText(/5 selected/).waitFor();
      assert.equal(starts.length, 1);
      await start.click();
      await page.getByRole("status").filter({ hasText: "0 of 30" }).waitFor();
      assert.equal(starts.length, 2);
      assert.deepEqual(
        starts[1].project_ids,
        projects.slice(25).map((p) => p.project_id),
      );
      await page.getByRole("tab", { name: "Scan Files" }).focus();
      await page.keyboard.press("Home");
      await dialog.waitFor({ state: "hidden" });
      await page.keyboard.press("End");
      await dialog.waitFor();
      assert.equal(
        await page
          .getByRole("tab", { name: "Scan Files", exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await context.close();
      context = undefined;
      process.stdout.write(
        `PASS ${dark ? "dark" : "light"}, ${zoom * 100}% zoom, 320 CSS px: keyboard, cancel, reload, partial results, explicit retry, focus, axe\n`,
      );
    }
} finally {
  await context?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await rm(temp, { recursive: true, force: true });
}
