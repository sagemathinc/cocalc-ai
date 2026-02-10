import { expect, test } from "@playwright/test";

async function waitForHarness(page) {
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        if (typeof window.__chatComposerTest?.getInput === "function") {
          return "ready";
        }
        if (window.__chatHarnessBootError != null) {
          return `boot-error:${window.__chatHarnessBootError}`;
        }
        return "waiting";
      });
    })
    .toBe("ready");
  await expectHarnessHealthy(page);
}

async function expectComposerInput(page, value: string) {
  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getInput?.() ?? null);
    })
    .toBe(value);
}

async function expectHarnessHealthy(page) {
  await expect
    .poll(async () => {
      return await page.evaluate(() => ({
        bootError: window.__chatHarnessBootError ?? null,
        rootChildren: document.getElementById("root")?.childElementCount ?? 0,
      }));
    })
    .toEqual({ bootError: null, rootChildren: 1 });
}

async function setInputRaw(page, value: string) {
  await page.evaluate((next) => {
    window.__chatComposerTest?.setInputRaw?.(next);
  }, value);
}

async function typeInCodeMirror(page, text: string) {
  const editor = page.locator(".CodeMirror-code[contenteditable='true']").first();
  await expect(editor).toHaveCount(1);
  await editor.click();
  await page.keyboard.type(text);
}

async function typeInSlate(page, text: string) {
  const editor = page.locator("[data-slate-editor='true']").first();
  await expect(editor).toHaveCount(1);
  await editor.click();
  await page.keyboard.type(text);
}

test("new-thread shift+enter send clears and stays cleared", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  await typeInCodeMirror(page, "x");
  await expectComposerInput(page, "x");
  await page.keyboard.press("Shift+Enter");

  await expectComposerInput(page, "");
  await expectHarnessHealthy(page);

  await page.waitForTimeout(3000);

  const inputAfterDelay = await page.evaluate(
    () => window.__chatComposerTest?.getInput?.() ?? null,
  );
  expect(inputAfterDelay).toBe("");
  await expectHarnessHealthy(page);
});

test("second new-thread send also stays cleared after New Chat", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  await typeInCodeMirror(page, "first");
  await expectComposerInput(page, "first");
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await page.evaluate(() => {
    window.__chatComposerTest?.newChat?.();
  });

  await typeInCodeMirror(page, "second");
  await expectComposerInput(page, "second");
  await page.keyboard.press("Shift+Enter");

  await expectComposerInput(page, "");
  await expectHarnessHealthy(page);

  await page.waitForTimeout(3000);
  const inputAfterDelay = await page.evaluate(
    () => window.__chatComposerTest?.getInput?.() ?? null,
  );
  expect(inputAfterDelay).toBe("");
  await expectHarnessHealthy(page);
});

test("composer mode: send button appears while typing without blur", async ({ page }) => {
  await page.goto("/?mode=composer&editorMode=markdown");
  await waitForHarness(page);

  await typeInCodeMirror(page, "hello");
  await expectComposerInput(page, "hello");

  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSendButtonVisible?.());
    })
    .toBe(true);
  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSendButtonDisabled?.());
    })
    .toBe(false);
  await expectHarnessHealthy(page);
});

test("composer mode: shift+enter sends and clears without blur", async ({ page }) => {
  await page.goto("/?mode=composer&editorMode=markdown");
  await waitForHarness(page);

  await typeInCodeMirror(page, "quick-send");
  await expectComposerInput(page, "quick-send");
  await page.keyboard.press("Shift+Enter");

  await expectComposerInput(page, "");
  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSends?.().length ?? 0);
    })
    .toBeGreaterThan(0);
  await expectHarnessHealthy(page);
});

test("composer editor mode: send button appears while typing", async ({ page }) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await typeInSlate(page, "hello");
  await expectComposerInput(page, "hello");

  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSendButtonVisible?.());
    })
    .toBe(true);
  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSendButtonDisabled?.());
    })
    .toBe(false);
  await expectHarnessHealthy(page);
});

test("composer editor mode: shift+enter sends and clears", async ({ page }) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await typeInSlate(page, "quick-send");
  await expectComposerInput(page, "quick-send");
  await page.keyboard.press("Shift+Enter");

  await expectComposerInput(page, "");
  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSends?.().length ?? 0);
    })
    .toBeGreaterThan(0);
  await expectHarnessHealthy(page);
});

test("composer editor mode: shift+enter stays cleared across draft-key oscillation", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await page.evaluate(() => {
    window.__chatComposerTest?.setOscillationEnabled?.(true);
  });

  await typeInSlate(page, "x");
  await expectComposerInput(page, "x");
  await page.keyboard.press("Shift+Enter");

  await expectComposerInput(page, "");
  await expectHarnessHealthy(page);

  await page.waitForTimeout(3500);
  await expectComposerInput(page, "");
  await expectHarnessHealthy(page);
});

test("composer editor mode: follow-up after first send shows Send and clears on shift+enter", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await page.evaluate(() => {
    window.__chatComposerTest?.setOscillationEnabled?.(true);
  });

  await typeInSlate(page, "x");
  await expectComposerInput(page, "x");
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  // Let draft-key oscillation settle before follow-up typing.
  await page.waitForTimeout(600);

  await typeInSlate(page, "y");
  await expectComposerInput(page, "y");

  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSendButtonVisible?.());
    })
    .toBe(true);

  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await page.waitForTimeout(2500);
  await expectComposerInput(page, "");
  await expectHarnessHealthy(page);
});

test("composer editor mode: repeated follow-up shift+enter sends always show Send and clear", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await page.evaluate(() => {
    window.__chatComposerTest?.setOscillationEnabled?.(true);
  });

  await typeInSlate(page, "x");
  await expectComposerInput(page, "x");
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await page.waitForTimeout(600);

  await typeInSlate(page, "y");
  await expectComposerInput(page, "y");
  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSendButtonVisible?.());
    })
    .toBe(true);
  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSendButtonDisabled?.());
    })
    .toBe(false);
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await page.waitForTimeout(600);

  await typeInSlate(page, "z");
  await expectComposerInput(page, "z");
  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSendButtonVisible?.());
    })
    .toBe(true);
  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSendButtonDisabled?.());
    })
    .toBe(false);
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSends?.() ?? []);
    })
    .toEqual(["x", "y", "z"]);
  await expectHarnessHealthy(page);
});

test("composer editor mode: image-markdown-only shift+enter clears on repeated sends", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  const image1 =
    "![](http://127.0.0.1:30004/blobs/test-image-1?uuid=11111111-1111-4111-8111-111111111111)\n";
  const image2 =
    "![](http://127.0.0.1:30004/blobs/test-image-2?uuid=22222222-2222-4222-8222-222222222222)\n";

  await setInputRaw(page, image1);
  await expectComposerInput(page, image1);
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await setInputRaw(page, image2);
  await expectComposerInput(page, image2);
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await expect
    .poll(async () => {
      return await page.evaluate(() => window.__chatComposerTest?.getSends?.().length ?? 0);
    })
    .toBe(2);
  await expectHarnessHealthy(page);
});
