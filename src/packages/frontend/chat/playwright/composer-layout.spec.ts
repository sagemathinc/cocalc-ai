import { expect, test } from "@playwright/test";

test("New Agent compact menu opens without a frame and restores keyboard focus", async ({
  page,
}) => {
  await page.goto("/?mode=new-agent&editorMode=editor");
  const editor = page.getByRole("textbox", { name: "Ask your agent" });
  await editor.fill("Draft preserved through mode changes");
  const trigger = page.getByRole("button", {
    name: "Editor mode and formatting",
  });
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "Text formatting" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close formatting" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await page
    .locator(".ant-radio-button-wrapper:visible")
    .filter({ hasText: "Markdown" })
    .click();
  await expect(page.locator(".CodeMirror")).toContainText(
    "Draft preserved through mode changes",
  );
});

test("New Agent rich text grows to its cap and scrolls with a wheel", async ({
  page,
}) => {
  await page.goto("/?mode=new-agent&editorMode=editor");
  const editor = page.getByRole("textbox", { name: "Ask your agent" });
  await editor.click();
  for (let line = 0; line < 35; line++) {
    await page.keyboard.type(`Line ${line}`);
    await page.keyboard.press("Enter");
  }
  const dimensions = await editor.evaluate((node) => ({
    height: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflow: getComputedStyle(node).overflowY,
  }));
  expect(dimensions.height).toBe(420);
  expect(dimensions.scrollHeight).toBeGreaterThan(420);
  expect(dimensions.overflow).toBe("auto");
  await editor.evaluate((node) => {
    node.scrollTop = 0;
  });
  await editor.hover();
  await page.mouse.wheel(0, 350);
  await expect
    .poll(() => editor.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  const scrollTop = await editor.evaluate((node) => node.scrollTop);
  await page.mouse.wheel(0, -200);
  await expect
    .poll(() => editor.evaluate((node) => node.scrollTop))
    .toBeLessThan(scrollTop);
});

test("New Agent markdown grows beyond two lines then uses only CodeMirror scrolling", async ({
  page,
}) => {
  await page.goto("/?mode=new-agent&editorMode=markdown");
  const editor = page.locator(".CodeMirror");
  await expect(editor).toBeVisible();
  const initial = (await editor.boundingBox())!.height;
  await editor.locator(".CodeMirror-code").click();
  for (let line = 0; line < 8; line++) {
    await page.keyboard.type(`Line ${line}`);
    await page.keyboard.press("Enter");
  }
  await expect
    .poll(async () => (await editor.boundingBox())!.height)
    .toBeGreaterThan(initial + 80);
  for (let line = 8; line < 35; line++) {
    await page.keyboard.type(`Line ${line}`);
    await page.keyboard.press("Enter");
  }
  await expect.poll(async () => (await editor.boundingBox())!.height).toBe(420);
  expect(await editor.evaluate((node) => getComputedStyle(node).overflow)).toBe(
    "hidden",
  );
  await editor.evaluate((node: any) => node.CodeMirror.scrollTo(0, 0));
  await editor.hover();
  await page.mouse.wheel(0, 250);
  await expect
    .poll(() =>
      editor.evaluate((node: any) => node.CodeMirror.getScrollInfo().top),
    )
    .toBeGreaterThan(0);
  expect(await editor.evaluate((node) => node.scrollTop)).toBe(0);
});

test("manually sized markdown has one scrolling owner", async ({ page }) => {
  await page.goto("/?mode=composer&editorMode=markdown");
  const editor = page.locator(".CodeMirror");
  await expect(editor).toBeVisible();
  await page.evaluate(() =>
    window.__chatComposerTest?.setInputRaw("line\n".repeat(40)),
  );
  await expect(editor).toContainText("line");
  const before = (await editor.boundingBox())!.height;
  const resize = page.getByRole("separator", { name: "Resize composer" });
  await resize.focus();
  await resize.press("ArrowUp");
  await expect
    .poll(async () => (await editor.boundingBox())!.height)
    .toBeGreaterThan(before);
  expect(await editor.evaluate((node) => getComputedStyle(node).overflow)).toBe(
    "hidden",
  );
  await editor.evaluate((node: any) => node.CodeMirror.scrollTo(0, 0));
  await editor.hover();
  await page.mouse.wheel(0, 250);
  await expect
    .poll(() =>
      editor.evaluate((node: any) => node.CodeMirror.getScrollInfo().top),
    )
    .toBeGreaterThan(0);
  expect(await editor.evaluate((node) => node.scrollTop)).toBe(0);
});

test("fullscreen keeps formatting, settings popovers and modals interactive", async ({
  page,
}) => {
  await page.goto("/?mode=composer-settings&editorMode=editor");
  await page.getByRole("textbox").fill("Unsent draft");
  const trigger = page.getByRole("button", {
    name: "Editor mode and formatting",
  });
  await trigger.click();
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.fullscreenElement?.getAttribute("data-testid"),
      ),
    )
    .toBe("chat-composer");
  await page
    .getByRole("button", { name: "Model settings", exact: true })
    .click();
  const choice = page.getByRole("button", { name: "Choose model" });
  await expect(choice).toBeVisible();
  expect(
    await choice.evaluate((node) => document.fullscreenElement?.contains(node)),
  ).toBe(true);
  await choice.click();
  const dialog = page.getByRole("dialog", { name: "Model options" });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((node) => document.fullscreenElement?.contains(node)),
  ).toBe(true);
  await page.getByRole("button", { name: "Keep current model" }).click();
  await expect(dialog).not.toBeVisible();
  await trigger.click();
  await page
    .getByRole("button", { name: "Exit fullscreen", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement == null))
    .toBe(true);
  await expect(page.getByRole("textbox")).toContainText("Unsent draft");
});
