import { expect, test } from "@playwright/test";

async function waitForHarness(page) {
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        if (typeof window.__chatComposerTest?.getInput === "function") {
          return "ready";
        }
        if (typeof window.__chatSearchTest?.getSearchCalls === "function") {
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
      return await page.evaluate(
        () => window.__chatComposerTest?.getInput?.() ?? null,
      );
    })
    .toBe(value);
}

async function expectVisibleCodeMirrorValue(page, value: string) {
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const cmNode = document.querySelector(".CodeMirror");
        const cm = cmNode && (cmNode as any).CodeMirror;
        return cm?.getValue?.() ?? null;
      });
    })
    .toBe(value);
}

async function expectComposerInputAfterSwitch(
  page,
  previous: string,
  inserted: string,
) {
  await expect
    .poll(async () => {
      return await page.evaluate(
        () => window.__chatComposerTest?.getInput?.() ?? null,
      );
    })
    .not.toBe(previous);

  const next = await page.evaluate(
    () => window.__chatComposerTest?.getInput?.() ?? null,
  );
  expect(typeof next).toBe("string");
  expect(next).toContain(inserted);
  expect(next?.length).toBe(previous.length + inserted.length);
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
  const editor = page
    .locator(".CodeMirror-code[contenteditable='true']")
    .first();
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

async function clickSendButton(page) {
  const send = page.getByRole("button", { name: "Send" }).first();
  await expect(send).toBeVisible();
  await expect(send).toBeEnabled();
  await send.click();
}

async function switchComposerMode(page, label: "Rich Text" | "Markdown") {
  const button = page
    .locator(".ant-radio-button-wrapper")
    .filter({ hasText: label })
    .first();
  await expect(button).toBeVisible();
  await button.click();
}

async function expectMarkdownCaretVisible(page) {
  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const cm = (document.querySelector(".CodeMirror") as any)?.CodeMirror;
        const scroller =
          document.querySelector<HTMLElement>(".CodeMirror-scroll");
        if (cm == null || scroller == null) {
          return null;
        }
        const cursorBox = cm.cursorCoords(cm.getDoc().getCursor(), "page");
        const scrollerBox = scroller.getBoundingClientRect();
        return {
          visible:
            cursorBox.top >= scrollerBox.top - 1 &&
            cursorBox.bottom <= scrollerBox.bottom + 1,
        };
      });
    })
    .toEqual({ visible: true });
}

async function getMarkdownComposerOverflow(page) {
  return await page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>(".CodeMirror");
    const host = wrapper?.parentElement as HTMLElement | null;
    const body = host?.parentElement as HTMLElement | null;
    const shell = body?.parentElement as HTMLElement | null;
    if (wrapper == null || host == null || body == null || shell == null) {
      return null;
    }
    const bodyRect = body.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      overflow: Math.round(bodyRect.bottom - shellRect.bottom),
      bodyHeight: Math.round(bodyRect.height),
      shellHeight: Math.round(shellRect.height),
    };
  });
}

test("new-thread shift+enter send clears and stays cleared", async ({
  page,
}) => {
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

test("second new-thread send also stays cleared after New Chat", async ({
  page,
}) => {
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

test("composer mode: send button appears while typing without blur", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=markdown");
  await waitForHarness(page);

  await typeInCodeMirror(page, "hello");
  await expectComposerInput(page, "hello");

  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonVisible?.(),
      );
    })
    .toBe(true);
  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonDisabled?.(),
      );
    })
    .toBe(false);
  await expectHarnessHealthy(page);
});

test("composer mode: shift+enter sends and clears without blur", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=markdown");
  await waitForHarness(page);

  await typeInCodeMirror(page, "quick-send");
  await expectComposerInput(page, "quick-send");
  await expectVisibleCodeMirrorValue(page, "quick-send");
  await page.keyboard.press("Shift+Enter");

  await expectComposerInput(page, "");
  await expectVisibleCodeMirrorValue(page, "");
  await expect
    .poll(async () => {
      return await page.evaluate(
        () => window.__chatComposerTest?.getSends?.().length ?? 0,
      );
    })
    .toBeGreaterThan(0);
  await expectHarnessHealthy(page);
});

test("composer mode: switching from markdown to rich text keeps typing live", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=markdown");
  await waitForHarness(page);

  await typeInCodeMirror(page, "ab");
  await expectComposerInput(page, "ab");

  await switchComposerMode(page, "Rich Text");
  await page.keyboard.type("c");

  await expectComposerInputAfterSwitch(page, "ab", "c");
  await expectHarnessHealthy(page);
});

test("composer mode: markdown to rich text preserves a mid-line caret", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=markdown");
  await waitForHarness(page);

  await typeInCodeMirror(page, "abcd");
  await expectComposerInput(page, "abcd");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");

  await switchComposerMode(page, "Rich Text");
  await page.keyboard.type("X");

  await expectComposerInput(page, "abXcd");
  await expectHarnessHealthy(page);
});

test("composer mode: markdown keeps the caret visible while typing short multiline input", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=markdown");
  await waitForHarness(page);

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".CodeMirror-scroll");
    (window as any).__cmScrollTops = [];
    scroller?.addEventListener("scroll", () => {
      (window as any).__cmScrollTops.push(scroller.scrollTop);
    });
  });

  await typeInCodeMirror(page, "a\nb\nc\nd\ne\nf\ng\nhx kdkdkdkdk");
  await expectMarkdownCaretVisible(page);

  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        const scrollTops = ((window as any).__cmScrollTops ?? []) as number[];
        return Math.max(0, ...scrollTops);
      });
    })
    .toBe(0);
});

test("composer mode: markdown keeps the caret visible while moving upward", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=markdown");
  await waitForHarness(page);

  await page.evaluate(() => {
    const cm = (document.querySelector(".CodeMirror") as any)?.CodeMirror;
    const scroller = document.querySelector<HTMLElement>(".CodeMirror-scroll");
    (window as any).__cmArrowUpVisibility = [];
    document.addEventListener(
      "keyup",
      (event) => {
        if (event.key !== "ArrowUp" || cm == null || scroller == null) return;
        const cursorBox = cm.cursorCoords(cm.getDoc().getCursor(), "page");
        const scrollerBox = scroller.getBoundingClientRect();
        (window as any).__cmArrowUpVisibility.push(
          cursorBox.top >= scrollerBox.top - 1 &&
            cursorBox.bottom <= scrollerBox.bottom + 1,
        );
      },
      true,
    );
  });

  await typeInCodeMirror(
    page,
    Array.from({ length: 20 }, (_, i) => `${i + 1}`).join("\n"),
  );

  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("ArrowUp");
    await expectMarkdownCaretVisible(page);
  }

  await expect
    .poll(async () => {
      return await page.evaluate(
        () => (window as any).__cmArrowUpVisibility ?? [],
      );
    })
    .toEqual(Array.from({ length: 10 }, () => true));
});

test("composer mode: markdown body does not overflow while typing multiline text", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=markdown");
  await waitForHarness(page);

  await typeInCodeMirror(
    page,
    "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8",
  );
  await expectComposerInput(
    page,
    "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8",
  );

  await expect
    .poll(async () => (await getMarkdownComposerOverflow(page))?.overflow)
    .toBe(0);
});

test("composer editor mode: send button appears while typing", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await typeInSlate(page, "hello");
  await expectComposerInput(page, "hello");

  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonVisible?.(),
      );
    })
    .toBe(true);
  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonDisabled?.(),
      );
    })
    .toBe(false);
  await expectHarnessHealthy(page);
});

test("composer mode: rich text to markdown preserves a mid-line caret", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await typeInSlate(page, "abcd");
  await expectComposerInput(page, "abcd");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");

  await switchComposerMode(page, "Markdown");
  await page.keyboard.type("Y");

  await expectComposerInput(page, "abYcd");
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
      return await page.evaluate(
        () => window.__chatComposerTest?.getSends?.().length ?? 0,
      );
    })
    .toBeGreaterThan(0);
  await expectHarnessHealthy(page);
});

test("composer editor mode: send button keeps slate ready for immediate follow-up typing", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await typeInSlate(page, "first");
  await expectComposerInput(page, "first");
  await clickSendButton(page);
  await expectComposerInput(page, "");

  await page.keyboard.type("x");
  await expectComposerInput(page, "x");
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
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonVisible?.(),
      );
    })
    .toBe(true);

  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await page.waitForTimeout(2500);
  await expectComposerInput(page, "");
  await expectHarnessHealthy(page);
});

test("composer editor mode: switching to markdown keeps typing live", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await typeInSlate(page, "ab");
  await expectComposerInput(page, "ab");

  await switchComposerMode(page, "Markdown");
  await page.keyboard.type("c");

  await expectComposerInputAfterSwitch(page, "ab", "c");
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
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonVisible?.(),
      );
    })
    .toBe(true);
  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonDisabled?.(),
      );
    })
    .toBe(false);
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await page.waitForTimeout(600);

  await typeInSlate(page, "z");
  await expectComposerInput(page, "z");
  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonVisible?.(),
      );
    })
    .toBe(true);
  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonDisabled?.(),
      );
    })
    .toBe(false);
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await expect
    .poll(async () => {
      return await page.evaluate(
        () => window.__chatComposerTest?.getSends?.() ?? [],
      );
    })
    .toEqual(["x", "y", "z"]);
  await expectHarnessHealthy(page);
});

test("composer editor mode: mixed text/image sends clear for both shift+enter and button", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await page.evaluate(() => {
    window.__chatComposerTest?.setOscillationEnabled?.(true);
  });

  const image1 =
    "![](http://127.0.0.1:30004/blobs/mixed-image-1?uuid=33333333-3333-4333-8333-333333333333)\n";
  const image2 =
    "![](http://127.0.0.1:30004/blobs/mixed-image-2?uuid=44444444-4444-4444-8444-444444444444)\n";

  await typeInSlate(page, "alpha");
  await expectComposerInput(page, "alpha");
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await page.waitForTimeout(600);

  await setInputRaw(page, image1);
  await expectComposerInput(page, image1);
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await page.waitForTimeout(600);

  await setInputRaw(page, image2);
  await expectComposerInput(page, image2);
  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonVisible?.(),
      );
    })
    .toBe(true);
  await clickSendButton(page);
  await expectComposerInput(page, "");

  await expect
    .poll(async () => {
      return await page.evaluate(
        () => window.__chatComposerTest?.getSends?.() ?? [],
      );
    })
    .toEqual(["alpha", image1.trim(), image2.trim()]);
  await expectHarnessHealthy(page);
});

test("composer editor mode: after mixed sends, another follow-up still shows Send and clears", async ({
  page,
}) => {
  await page.goto("/?mode=composer&editorMode=editor");
  await waitForHarness(page);

  await page.evaluate(() => {
    window.__chatComposerTest?.setOscillationEnabled?.(true);
  });

  const image =
    "![](http://127.0.0.1:30004/blobs/mixed-image-3?uuid=55555555-5555-4555-8555-555555555555)\n";

  await typeInSlate(page, "x");
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await page.waitForTimeout(600);

  await setInputRaw(page, image);
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await page.waitForTimeout(600);

  await typeInSlate(page, "y");
  await expectComposerInput(page, "y");
  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonVisible?.(),
      );
    })
    .toBe(true);
  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        window.__chatComposerTest?.getSendButtonDisabled?.(),
      );
    })
    .toBe(false);
  await page.keyboard.press("Shift+Enter");
  await expectComposerInput(page, "");

  await expect
    .poll(async () => {
      return await page.evaluate(
        () => window.__chatComposerTest?.getSends?.() ?? [],
      );
    })
    .toEqual(["x", image.trim(), "y"]);
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
      return await page.evaluate(
        () => window.__chatComposerTest?.getSends?.().length ?? 0,
      );
    })
    .toBe(2);
  await expectHarnessHealthy(page);
});

test("archived search hit click hydrates and jumps to message", async ({
  page,
}) => {
  await page.goto("/?mode=archived-search");
  await waitForHarness(page);

  await expect(page.getByText("cross-thread backend match")).toBeVisible();
  await page.getByText("cross-thread backend match").click();

  await expect
    .poll(async () => {
      return await page.evaluate(
        () => window.__chatSearchTest?.getReadHitCalls?.().length ?? 0,
      );
    })
    .toBeGreaterThan(0);

  await expect
    .poll(async () => {
      return await page.evaluate(
        () => window.__chatSearchTest?.getHydratedDates?.().length ?? 0,
      );
    })
    .toBeGreaterThan(0);

  await expect
    .poll(async () => {
      return await page.evaluate(
        () => window.__chatSearchTest?.getGotoCalls?.().length ?? 0,
      );
    })
    .toBeGreaterThan(0);

  const firstGoto = await page.evaluate(() => {
    const calls = window.__chatSearchTest?.getGotoCalls?.() ?? [];
    return calls[0] ?? null;
  });
  expect(firstGoto).toBeTruthy();
  expect(Object.values(firstGoto as any)[0]).toMatch(/^\d+$/);
  await expectHarnessHealthy(page);
});
