// Live semantic scroll acceptance. Changes only viewer preferences/scroll state.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const [chat, commit] = process.argv.slice(2);
if (!chat || !/^[a-f0-9]{40,64}$/.test(commit ?? ""))
  throw Error("Supply chat URL and full commit hash");
const url = new URL(chat);
url.searchParams.set("git-hash", commit);
const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const page = await browser.contexts()[0].newPage();
let previousRenderer;
const renderer = page.getByRole("combobox", {
  name: "Diff renderer",
  exact: true,
});
async function visibleAnchor() {
  return page.evaluate(() => {
    const pierre = document.querySelector('[aria-label="Git diff"]');
    const candidates = [];
    if (pierre) {
      const bounds = pierre.getBoundingClientRect();
      for (const host of pierre.querySelectorAll("diffs-container")) {
        const header = host.querySelector("[data-review-file-header]");
        const top = Math.max(
          bounds.top,
          header?.getBoundingClientRect().bottom ?? bounds.top,
        );
        for (const row of host.shadowRoot?.querySelectorAll("[data-line]") ??
          []) {
          const rect = row.getBoundingClientRect();
          if (rect.height > 0 && rect.bottom > top && rect.top < bounds.bottom)
            candidates.push({
              path: header?.getAttribute("data-review-file-header"),
              line: Number(row.getAttribute("data-line")),
              top: rect.top,
            });
        }
      }
    } else {
      for (const section of document.querySelectorAll(
        "[data-git-diff-section]",
      )) {
        let viewport = section.parentElement;
        while (viewport && getComputedStyle(viewport).overflowY !== "auto")
          viewport = viewport.parentElement;
        if (!viewport) continue;
        const bounds = viewport.getBoundingClientRect();
        const header = section.querySelector("[data-review-file-id]");
        const top = Math.max(
          bounds.top,
          header?.getBoundingClientRect().bottom ?? bounds.top,
        );
        for (const row of section.querySelectorAll(".cocalc-git-diff-line")) {
          const rect = row.getBoundingClientRect();
          if (rect.height > 0 && rect.bottom > top && rect.top < bounds.bottom)
            candidates.push({
              path: header
                ?.querySelector('[title="Copy file path"]')
                ?.textContent.trim(),
              line: Number(
                row.getAttribute("data-review-new-line") ??
                  row.getAttribute("data-review-old-line"),
              ),
              top: rect.top,
            });
        }
      }
    }
    return candidates
      .filter((c) => c.line > 0)
      .sort((a, b) => a.top - b.top)[0];
  });
}
try {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await expect(renderer).toBeVisible({ timeout: 60000 });
  previousRenderer = await renderer.inputValue();
  await renderer.selectOption("pierre");
  const viewport = page.getByRole("region", { name: "Git diff", exact: true });
  await expect(viewport).toBeVisible({ timeout: 60000 });
  await page
    .getByRole("combobox", { name: "Changed files", exact: true })
    .selectOption("0");
  await viewport.evaluate((e) => {
    e.scrollTop = 2000;
  });
  await expect
    .poll(async () => (await visibleAnchor())?.line ?? 0)
    .toBeGreaterThan(20);
  await page.waitForTimeout(800);
  const anchor = await visibleAnchor();
  console.log("Initial visible anchor", anchor);
  async function matches(label) {
    await page.waitForTimeout(1500);
    await expect
      .poll(
        async () => {
          const next = await visibleAnchor();
          return (
            next?.path === anchor.path && Math.abs(next.line - anchor.line) <= 3
          );
        },
        { message: label, timeout: 15000 },
      )
      .toBe(true);
    console.log(label, await visibleAnchor());
  }
  await renderer.selectOption("legacy");
  await matches("Classic handoff");
  await renderer.selectOption("pierre");
  await matches("Pierre handoff");
  await viewport.focus();
  await page.keyboard.press("Escape");
  await expect(renderer).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open git browser", exact: true })
    .click();
  await expect(renderer).toBeVisible({ timeout: 60000 });
  await matches("Drawer reopen");
  console.log(
    "Passed: same file/source line survives renderer roundtrip and close/reopen.",
  );
} catch (error) {
  console.error(
    "Final visible anchor",
    await visibleAnchor().catch(() => undefined),
  );
  throw error;
} finally {
  if (previousRenderer)
    await renderer.selectOption(previousRenderer).catch(() => {});
  await page.close();
}
process.exit(0);
