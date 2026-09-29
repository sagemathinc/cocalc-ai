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

// The chat composer fits its text: about one line when empty, growing to 40%
// of the viewport (288px at Playwright's default 720px), then scrolling.
const ONE_LINE_MAX = 70;
const AUTO_CAP = 288;

async function composerInputHeight(page) {
  return Math.round(
    (await page.getByTestId("chat-composer-input").boundingBox())!.height,
  );
}

async function pageScrollTop(page) {
  return page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
}

for (const editorMode of ["editor", "markdown"] as const) {
  test(`chat composer (${editorMode}) fits its text, caps, and shrinks back`, async ({
    page,
  }) => {
    await page.goto(`/?mode=composer&editorMode=${editorMode}`);
    const empty = await composerInputHeight(page);
    expect(empty).toBeLessThanOrEqual(ONE_LINE_MAX);

    const focusEditor = async () => {
      if (editorMode === "editor") await page.getByRole("textbox").click();
      else await page.locator(".CodeMirror-code").click();
    };
    await focusEditor();
    for (let line = 0; line < 5; line++) {
      await page.keyboard.type(`Line ${line}`);
      await page.keyboard.press("Enter");
    }
    await expect
      .poll(() => composerInputHeight(page))
      .toBeGreaterThan(empty + 60);

    for (let line = 5; line < 40; line++) {
      await page.keyboard.type(`Line ${line}`);
      await page.keyboard.press("Enter");
    }
    await page.keyboard.type("last line");
    await expect
      .poll(() => composerInputHeight(page))
      .toBeGreaterThan(AUTO_CAP - 40);
    expect(await composerInputHeight(page)).toBeLessThanOrEqual(AUTO_CAP + 12);

    // The caret stays visible inside the capped editor.
    const caretVisible = await page.evaluate((mode) => {
      const input = document.querySelector(
        '[data-testid="chat-composer-input"]',
      )!;
      const box = input.getBoundingClientRect();
      let caret: DOMRect | undefined;
      if (mode === "editor") {
        caret = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
      } else {
        const cm = (document.querySelector(".CodeMirror") as any).CodeMirror;
        const c = cm.cursorCoords(cm.getDoc().getCursor(), "window");
        caret = { top: c.top, bottom: c.bottom } as DOMRect;
      }
      return (
        caret != null &&
        caret.top >= box.top - 2 &&
        caret.bottom <= box.bottom + 2
      );
    }, editorMode);
    expect(caretVisible).toBe(true);
    expect(await pageScrollTop(page)).toBe(0);

    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await expect
      .poll(() => composerInputHeight(page))
      .toBeLessThanOrEqual(ONE_LINE_MAX);
  });
}

for (const editorMode of ["editor", "markdown"] as const) {
  test(`chat composer (${editorMode}) sizes to a draft set all at once`, async ({
    page,
  }) => {
    // Pasting, restoring a draft, or quoting replaces the value, not typing.
    await page.goto(`/?mode=composer&editorMode=${editorMode}`);
    await page.evaluate(() =>
      window.__chatComposerTest?.setInputRaw(
        Array.from({ length: 30 }, (_, i) => `Pasted line ${i}`).join("\n\n"),
      ),
    );
    await expect
      .poll(() => composerInputHeight(page))
      .toBeGreaterThan(AUTO_CAP - 40);
    expect(await composerInputHeight(page)).toBeLessThanOrEqual(AUTO_CAP + 12);
    expect(await pageScrollTop(page)).toBe(0);
    await page.evaluate(() => window.__chatComposerTest?.setInputRaw("short"));
    await expect
      .poll(() => composerInputHeight(page))
      .toBeLessThanOrEqual(ONE_LINE_MAX);
  });
}

test("a dragged composer height is kept until reset to fit the text", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  const empty = await composerInputHeight(page);
  const resize = page.getByRole("separator", { name: "Resize composer" });
  await expect(resize).toHaveAttribute("aria-valuetext", "Fits the text");
  await resize.focus();
  for (let i = 0; i < 5; i++) await resize.press("ArrowUp");
  await expect
    .poll(() => composerInputHeight(page))
    .toBeGreaterThan(empty + 80);
  await resize.press("Home");
  await expect(resize).toHaveAttribute("aria-valuetext", "Fits the text");
  await expect
    .poll(() => composerInputHeight(page))
    .toBeLessThanOrEqual(ONE_LINE_MAX);
});

test("conversation settings sit below the composer box", async ({ page }) => {
  await page.goto("/?mode=composer-settings&editorMode=editor");
  const box = page.getByTestId("chat-composer-box");
  const settings = page.getByRole("group", { name: "Conversation settings" });
  await expect(settings).toBeVisible();
  expect(
    await settings.evaluate(
      (node) =>
        !document
          .querySelector('[data-testid="chat-composer-box"]')!
          .contains(node),
    ),
  ).toBe(true);
  await expect(
    settings.getByRole("button", { name: "Model settings", exact: true }),
  ).toBeVisible();
  await expect(box.getByTestId("chat-composer-send")).toBeVisible();
  const boxBottom = (await box.boundingBox())!;
  const settingsTop = (await settings.boundingBox())!.y;
  expect(settingsTop).toBeGreaterThanOrEqual(boxBottom.y + boxBottom.height);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 740 } });

  test("the chat composer stays small and settings take one line", async ({
    page,
  }) => {
    await page.goto("/?mode=composer-settings&editorMode=editor&mobile=1");
    const input = page.getByTestId("chat-composer-input");
    expect((await input.boundingBox())!.height).toBeLessThanOrEqual(
      ONE_LINE_MAX,
    );
    // The whole composer, settings included, is a small part of the screen.
    const composer = (await page.getByTestId("chat-composer").boundingBox())!;
    expect(composer.height).toBeLessThanOrEqual(740 * 0.25);
    const settings = page.getByRole("group", { name: "Conversation settings" });
    expect((await settings.boundingBox())!.height).toBeLessThanOrEqual(40);

    await page.getByRole("textbox").click();
    for (let line = 0; line < 30; line++) {
      await page.keyboard.type(`Line ${line}`);
      await page.keyboard.press("Enter");
    }
    // Grows to 30% of the phone's height, then scrolls.
    await expect
      .poll(async () => (await input.boundingBox())!.height)
      .toBeGreaterThan(740 * 0.3 - 40);
    expect((await input.boundingBox())!.height).toBeLessThanOrEqual(
      740 * 0.3 + 12,
    );
  });
});
