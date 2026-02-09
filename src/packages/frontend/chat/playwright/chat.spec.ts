import { expect, test } from "@playwright/test";

async function waitForHarness(page) {
  await page.waitForFunction(() => {
    return typeof window.__chatComposerTest?.getInput === "function";
  });
}

test("new-thread shift+enter send clears and stays cleared", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  const editor = page.locator("[data-testid='markdown-input-shim']");
  await editor.click();
  await page.keyboard.type("x");
  await page.keyboard.press("Shift+Enter");

  await expect.poll(async () => {
    return await page.evaluate(() => window.__chatComposerTest?.getInput?.() ?? null);
  }).toBe("");

  await page.waitForTimeout(3000);

  const inputAfterDelay = await page.evaluate(
    () => window.__chatComposerTest?.getInput?.() ?? null,
  );
  expect(inputAfterDelay).toBe("");
});

test("second new-thread send also stays cleared after New Chat", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  const editor = page.locator("[data-testid='markdown-input-shim']");

  await editor.click();
  await page.keyboard.type("first");
  await page.keyboard.press("Shift+Enter");
  await expect.poll(async () => {
    return await page.evaluate(() => window.__chatComposerTest?.getInput?.() ?? null);
  }).toBe("");

  await page.evaluate(() => {
    window.__chatComposerTest?.newChat?.();
  });

  await editor.click();
  await page.keyboard.type("second");
  await page.keyboard.press("Shift+Enter");

  await expect.poll(async () => {
    return await page.evaluate(() => window.__chatComposerTest?.getInput?.() ?? null);
  }).toBe("");

  await page.waitForTimeout(3000);
  const inputAfterDelay = await page.evaluate(
    () => window.__chatComposerTest?.getInput?.() ?? null,
  );
  expect(inputAfterDelay).toBe("");
});
