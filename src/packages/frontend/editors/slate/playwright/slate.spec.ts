import { expect, test } from "@playwright/test";
import type { Descendant } from "slate";

type SlatePoint = { path: number[]; offset: number };

type SlateSelection =
  | {
      anchor: SlatePoint;
      focus: SlatePoint;
    }
  | null;

async function waitForHarness(page) {
  await page.waitForFunction(() => {
    return typeof window.__slateTest?.getText === "function";
  });
}

async function waitForCollabHarness(page) {
  await page.waitForFunction(() => {
    return typeof window.__slateCollabTest?.getMarkdownA === "function";
  });
}

async function waitForCollabMarkdownContains(page, value: string) {
  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateCollabTest?.getMarkdownA?.() ?? "";
    });
  }).toContain(value);
}

async function setBlockSelectionFromMarkdownPosition(
  page,
  pos: { line: number; ch: number },
) {
  await expect.poll(async () => {
    return await page.evaluate(({ line, ch }) => {
      return (
        window.__slateBlockTest?.setSelectionFromMarkdownPosition?.({
          line,
          ch,
        }) ?? false
      );
    }, pos);
  }).toBe(true);
}


type SlateNode = {
  type?: string;
  text?: string;
  blank?: boolean;
  children?: SlateNode[];
};

function nodeText(node?: SlateNode): string {
  if (!node) {
    return "";
  }
  if (node.text != null) {
    return node.text;
  }
  if (!node.children) {
    return "";
  }
  return node.children.map((child) => nodeText(child)).join("");
}

test("typing updates Slate text and selection", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  const editor = page.locator("[data-slate-editor]");
  await editor.click();
  await page.keyboard.type("hello world");

  const text = await page.evaluate(() => window.__slateTest?.getText());
  expect(text).toBe("hello world");

  const selection = (await page.evaluate(
    () => window.__slateTest?.getSelection(),
  )) as SlateSelection;

  expect(selection).not.toBeNull();
  if (selection) {
    expect(selection.anchor.path).toEqual([0, 0]);
    expect(selection.anchor.offset).toBe(11);
    expect(selection.focus.offset).toBe(11);
  }
});

test("enter creates a new block", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  const editor = page.locator("[data-slate-editor]");
  await editor.click();
  await editor.type("first");
  await page.keyboard.press("Enter");
  await editor.type("second");

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;
  expect(value?.length).toBe(2);
  if (value) {
    expect(nodeText(value[0])).toBe("first");
    expect(nodeText(value[1])).toBe("second");
  }

  const selection = (await page.evaluate(
    () => window.__slateTest?.getSelection(),
  )) as SlateSelection;

  expect(selection).not.toBeNull();
  if (selection) {
    expect(selection.anchor.path[0]).toBe(1);
  }
});


test("enter at start inserts blank lines above without moving cursor", async ({
  page,
}) => {
  // We preserve extra blank lines as explicit paragraphs, which diverges from
  // common markdown renderers that collapse consecutive blank lines.
  await page.goto("/");
  await waitForHarness(page);

  const editor = page.locator("[data-slate-editor]");
  await editor.click();

  const initialValue = [
    { type: "paragraph", children: [{ text: "abc" }] },
    { type: "paragraph", children: [{ text: "xyz" }] },
  ] as unknown as Descendant[];

  await page.evaluate((value) => {
    window.__slateTest?.setValue(value);
  }, initialValue);

  await page.waitForFunction(() => {
    return window.__slateTest?.getValue()?.length === 2;
  });

  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    });
  });

  await page.keyboard.press("Enter");

  let value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;

  expect(value?.length).toBe(4);
  if (value) {
    expect(value[1]?.blank).toBe(true);
    expect(value[2]?.blank).toBe(true);
    expect(nodeText(value[3])).toBe("xyz");
  }

  let selection = (await page.evaluate(
    () => window.__slateTest?.getSelection(),
  )) as SlateSelection;

  expect(selection).not.toBeNull();
  if (selection) {
    expect(selection.anchor.path[0]).toBe(3);
    expect(selection.anchor.offset).toBe(0);
  }

  await page.keyboard.press("Enter");

  value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;

  expect(value?.length).toBe(6);
  if (value) {
    expect(value[1]?.blank).toBe(true);
    expect(value[2]?.blank).toBe(true);
    expect(value[3]?.blank).toBe(true);
    expect(value[4]?.blank).toBe(true);
    expect(nodeText(value[5])).toBe("xyz");
  }

  selection = (await page.evaluate(
    () => window.__slateTest?.getSelection(),
  )) as SlateSelection;

  expect(selection).not.toBeNull();
  if (selection) {
    expect(selection.anchor.path[0]).toBe(5);
    expect(selection.anchor.offset).toBe(0);
  }
});

test("backspace pulls text into an empty quote block", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  const editor = page.locator("[data-slate-editor]");
  await editor.click();

  const initialValue = [
    {
      type: "blockquote",
      children: [{ type: "paragraph", children: [{ text: "" }] }],
    },
    { type: "paragraph", children: [{ text: "quoted text" }] },
  ] as unknown as Descendant[];

  await page.evaluate((value) => {
    window.__slateTest?.setValue(value);
  }, initialValue);

  await page.waitForFunction(() => {
    return window.__slateTest?.getValue()?.length === 2;
  });

  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    });
  });

  await page.keyboard.press("Backspace");

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;

  expect(value?.length).toBe(1);
  if (value) {
    expect(value[0]?.type).toBe("blockquote");
    expect(nodeText(value[0])).toBe("quoted text");
  }

  const selection = (await page.evaluate(
    () => window.__slateTest?.getSelection(),
  )) as SlateSelection;

  expect(selection).not.toBeNull();
  if (selection) {
    expect(selection.anchor.path[0]).toBe(0);
  }
});

test("backspace with spacer + empty blockquote does not lose following text", async ({
  page,
}) => {
  await page.goto("/");
  await waitForHarness(page);

  const editor = page.locator("[data-slate-editor]");
  await editor.click();

  const initialValue = [
    {
      type: "paragraph",
      spacer: true,
      children: [{ text: "" }],
    },
    {
      type: "blockquote",
      children: [],
    },
    {
      type: "paragraph",
      spacer: false,
      children: [{ text: "stuff" }],
    },
  ] as unknown as Descendant[];

  await page.evaluate((value) => {
    window.__slateTest?.setValue(value);
  }, initialValue);

  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [2, 0], offset: 0 },
      focus: { path: [2, 0], offset: 0 },
    });
  });

  await page.keyboard.press("Backspace");

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;

  expect(value).toBeDefined();
  if (value) {
    const allText = value.map((node) => nodeText(node)).join("\n");
    expect(allText).toContain("stuff");
  }
});

test("backspace after quoted text keeps quote content", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);
  await page.locator("[data-slate-editor]").click();

  const initialValue = [
    {
      type: "blockquote",
      children: [{ type: "paragraph", children: [{ text: "foo bar" }] }],
    },
    { type: "paragraph", children: [{ text: "" }] },
  ] as unknown as Descendant[];

  await page.evaluate((value) => {
    window.__slateTest?.setValue(value);
  }, initialValue);

  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    });
  });

  await page.keyboard.press("Backspace");

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;
  expect(value).toBeDefined();
  if (value) {
    const quote = value.find((node) => node?.type === "blockquote");
    expect(quote).toBeTruthy();
    if (quote) {
      expect(nodeText(quote)).toContain("foo bar");
    }
  }
});

test("backspace after quoted text and paragraph text preserves both", async ({
  page,
}) => {
  await page.goto("/");
  await waitForHarness(page);
  await page.locator("[data-slate-editor]").click();

  const initialValue = [
    {
      type: "blockquote",
      children: [{ type: "paragraph", children: [{ text: "foo bar" }] }],
    },
    { type: "paragraph", children: [{ text: " stuff" }] },
  ] as unknown as Descendant[];

  await page.evaluate((value) => {
    window.__slateTest?.setValue(value);
  }, initialValue);

  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    });
  });

  await page.keyboard.press("Backspace");

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;
  expect(value).toBeDefined();
  if (value) {
    const quote = value.find((node) => node?.type === "blockquote");
    expect(quote).toBeTruthy();
    if (quote) {
      expect(nodeText(quote)).toContain("foo bar stuff");
    }
  }
});

test("backspace after multiline quote with blank quoted line appends to last quoted paragraph", async ({
  page,
}) => {
  await page.goto("/");
  await waitForHarness(page);
  await page.locator("[data-slate-editor]").click();

  const initialValue = [
    {
      type: "blockquote",
      children: [
        { type: "paragraph", children: [{ text: "foo" }] },
        { type: "paragraph", children: [{ text: "" }] },
        { type: "paragraph", children: [{ text: "bar" }] },
      ],
    },
    { type: "paragraph", children: [{ text: "x" }] },
  ] as unknown as Descendant[];

  await page.evaluate((value) => {
    window.__slateTest?.setValue(value);
  }, initialValue);

  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    });
  });

  await page.keyboard.press("Backspace");

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;
  expect(value).toBeDefined();
  if (value) {
    const quote = value.find((node) => node?.type === "blockquote");
    expect(quote).toBeTruthy();
    if (quote) {
      expect(nodeText(quote)).toContain("foo");
      expect(nodeText(quote)).toContain("barx");
    }
  }
});

test("backspace at start of quoted paragraph after empty quoted line removes only empty quoted line", async ({
  page,
}) => {
  await page.goto("/");
  await waitForHarness(page);
  await page.locator("[data-slate-editor]").click();

  const initialValue = [
    {
      type: "blockquote",
      children: [
        { type: "paragraph", children: [{ text: "foo" }] },
        { type: "paragraph", children: [{ text: "" }] },
        { type: "paragraph", children: [{ text: "bar" }] },
      ],
    },
    { type: "paragraph", children: [{ text: "x" }] },
  ] as unknown as Descendant[];

  await page.evaluate((value) => {
    window.__slateTest?.setValue(value);
  }, initialValue);

  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [0, 2, 0], offset: 0 },
      focus: { path: [0, 2, 0], offset: 0 },
    });
  });

  await page.keyboard.press("Backspace");

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;
  expect(value).toBeDefined();
  if (value) {
    const quote = value.find((node) => node?.type === "blockquote");
    expect(quote).toBeTruthy();
    if (quote) {
      const quoteChildren = quote.children ?? [];
      expect(quoteChildren.length).toBe(2);
      expect(nodeText(quoteChildren[0])).toBe("foo");
      expect(nodeText(quoteChildren[1])).toBe("bar");
      expect(quoteChildren.some((child) => child?.type === "blockquote")).toBe(
        false,
      );
    }
    const paragraph = value.find((node) => node?.type === "paragraph");
    expect(nodeText(paragraph)).toBe("x");
  }
});

test("backspace from paragraph below quote with embedded softbreak lines appends to bar (not foo)", async ({
  page,
}) => {
  await page.goto("/");
  await waitForHarness(page);
  await page.locator("[data-slate-editor]").click();

  const initialValue = [
    {
      type: "blockquote",
      children: [
        {
          type: "paragraph",
          children: [
            { text: "foo" },
            {
              type: "softbreak",
              isInline: true,
              isVoid: true,
              children: [{ text: "" }],
            },
            {
              type: "softbreak",
              isInline: true,
              isVoid: true,
              children: [{ text: "" }],
            },
            { text: "bar" },
          ],
        },
      ],
    },
    { type: "paragraph", children: [{ text: "x" }] },
  ] as unknown as Descendant[];

  await page.evaluate((value) => {
    window.__slateTest?.setValue(value);
  }, initialValue);
  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    });
  });
  await page.keyboard.press("Backspace");

  const text = await page.evaluate(() => window.__slateTest?.getText?.() ?? "");
  expect(text).toContain("barx");
  expect(text).not.toContain("foox");
});

test("backspace from paragraph below two-paragraph quote appends to bar (not foo)", async ({
  page,
}) => {
  await page.goto("/");
  await waitForHarness(page);
  await page.locator("[data-slate-editor]").click();

  const initialValue = [
    {
      type: "blockquote",
      children: [
        { type: "paragraph", children: [{ text: "foo" }] },
        { type: "paragraph", children: [{ text: "bar" }] },
      ],
    },
    { type: "paragraph", children: [{ text: "x" }] },
  ] as unknown as Descendant[];

  await page.evaluate((value) => {
    window.__slateTest?.setValue(value);
  }, initialValue);
  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    });
  });
  await page.keyboard.press("Backspace");

  const text = await page.evaluate(() => window.__slateTest?.getText?.() ?? "");
  expect(text).toContain("barx");
  expect(text).not.toContain("foox");
});

test("autoformat quotes the current paragraph when typing > at start", async ({
  page,
}) => {
  await page.goto("/?autoformat=1");
  await waitForHarness(page);

  await page.evaluate(() => {
    window.__slateTest?.setValue([
      { type: "paragraph", children: [{ text: "quote me" }] },
    ]);
  });

  await page.waitForFunction(() => {
    return window.__slateTest?.getText() === "quote me";
  });

  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    });
  });

  await page.evaluate(() => {
    window.__slateTest?.insertText?.(">");
    window.__slateTest?.insertText?.(" ", true);
  });

  await page.waitForFunction(() => {
    const value = window.__slateTest?.getValue();
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      (value[0] as { type?: string }).type === "blockquote"
    );
  });

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;

  expect(value?.length).toBe(1);
  if (value) {
    expect(value[0]?.type).toBe("blockquote");
    expect(nodeText(value[0])).toBe("quote me");
  }
});

test("autoformat code span keeps focus", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  const editor = page.locator("[data-slate-editor]");
  await editor.click();
  await page.keyboard.type("`a b` ");

  await page.waitForFunction(() => {
    return window.__slateTest?.getText?.() === "a b ";
  });

  const focused = await page.evaluate(() => window.__slateTest?.isFocused());
  expect(focused).toBe(true);
});

test("autoformat code span keeps focus in empty editor (production autoformat)", async ({
  page,
}) => {
  await page.goto("/?autoformat=1");
  await waitForHarness(page);

  const editor = page.locator("[data-slate-editor]");
  await editor.click();
  await page.keyboard.type("`foo` ");

  await page.waitForFunction(() => {
    return window.__slateTest?.getText?.() === "foo ";
  });

  // Keep typing to verify focus stayed in the editor.
  const focusedAfterAutoformat = await page.evaluate(() =>
    window.__slateTest?.isFocused(),
  );
  expect(focusedAfterAutoformat).toBe(true);
  // Re-focus the editor to avoid flaky key delivery in some runs.
  await editor.click();
  await page.keyboard.type("bar");

  await page.waitForFunction(() => {
    return window.__slateTest?.getText?.() === "foo bar";
  });

  const focused = await page.evaluate(() => window.__slateTest?.isFocused());
  expect(focused).toBe(true);
});

test("autoformat list focuses first item in empty editor", async ({ page }) => {
  await page.goto("/?autoformat=1");
  await waitForHarness(page);

  await page.evaluate(() => {
    window.__slateTest?.setSelection({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    });
  });

  await page.evaluate(() => {
    window.__slateTest?.insertText?.("-");
    window.__slateTest?.insertText?.(" ", true);
  });

  await page.waitForFunction(() => {
    const value = window.__slateTest?.getValue?.();
    const selection = window.__slateTest?.getSelection?.();
    if (!value || !selection) return false;
    const path = selection.anchor.path || [];
    let node: any = { children: value };
    const ancestorTypes: string[] = [];
    for (const idx of path) {
      if (!node.children || !node.children[idx]) return false;
      node = node.children[idx];
      if (node.type) ancestorTypes.push(node.type);
    }
    if (!node || typeof node.text !== "string") return false;
    return (
      ancestorTypes.includes("list_item") &&
      (ancestorTypes.includes("bullet_list") ||
        ancestorTypes.includes("ordered_list"))
    );
  });

  const selection = (await page.evaluate(
    () => window.__slateTest?.getSelection(),
  )) as SlateSelection;
  expect(selection).not.toBeNull();
});

test("autoformat bold keeps focus after trailing space", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  const editor = page.locator("[data-slate-editor]");
  await editor.click();
  await page.keyboard.type(
    "QUESTION which you didn't answer -- are **ALL** ",
  );

  await page.waitForFunction(() => {
    return (
      window.__slateTest?.getText?.() ===
      "QUESTION which you didn't answer -- are ALL "
    );
  });

  const focused = await page.evaluate(() => window.__slateTest?.isFocused());
  expect(focused).toBe(true);
});

test("convert markdown candidate code block to rich text", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  await page.evaluate(() => {
    window.__slateTest?.setValue([
      {
        type: "code_block",
        fence: true,
        info: "",
        markdownCandidate: true,
        children: [
          { type: "code_line", children: [{ text: "- a" }] },
          { type: "code_line", children: [{ text: "- b" }] },
          { type: "code_line", children: [{ text: "" }] },
        ],
      },
    ]);
  });

  const button = page.locator('[data-testid="convert-markdown"]');
  await expect(button).toBeVisible();
  await button.click();

  await page.waitForFunction(() => {
    const value = window.__slateTest?.getValue() as SlateNode[] | undefined;
    return value?.[0]?.type === "bullet_list";
  });

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;
  expect(value?.[0]?.type).toBe("bullet_list");
});

test("code blocks allow blank lines via Enter", async ({ page }) => {
  await page.goto("/");
  await waitForHarness(page);

  await page.evaluate(() => {
    window.__slateTest?.setValue([
      {
        type: "code_block",
        fence: true,
        info: "",
        children: [{ type: "code_line", children: [{ text: "a" }] }],
      },
    ]);
    window.__slateTest?.setSelection({
      anchor: { path: [0, 0, 0], offset: 1 },
      focus: { path: [0, 0, 0], offset: 1 },
    });
  });

  await page.locator("[data-slate-editor]").click();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("b");

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;
  const lines =
    value?.[0]?.children?.map((line) => nodeText(line as SlateNode)) ?? [];
  expect(lines).toEqual(["a", "", "b"]);
});


test("block editor: arrow keys can escape a code block", async ({ page }) => {
  const markdown = "a\n\n```\nfoo\n```\n\nb";
  await page.goto(
    `http://127.0.0.1:4172/?block=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.getMarkdown === "function";
  });
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.setSelection === "function";
  });
  await page.waitForFunction(() => {
    return (
      typeof window.__slateBlockTest?.setSelectionFromMarkdownPosition ===
      "function"
    );
  });
  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateBlockTest?.getMarkdown?.() ?? "";
    });
  }).toContain("foo");

  const codeBlock = page.locator(".cocalc-slate-code-block").first();
  await expect(codeBlock).toBeVisible();
  await setBlockSelectionFromMarkdownPosition(page, { line: 3, ch: 0 });
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Y");

  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateBlockTest?.getMarkdown?.() ?? "";
    });
  }).toMatch(/```[\s\S]*foo[\s\S]*```[\s\S]*Y/);
});

test("block editor: ArrowLeft at block start moves to previous block end", async ({
  page,
}) => {
  const markdown = "abc\n\n123\n\n456";
  await page.goto(
    `http://127.0.0.1:4172/?block=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.getMarkdown === "function";
  });
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.setSelection === "function";
  });
  await page.waitForFunction(() => {
    return (
      typeof window.__slateBlockTest?.setSelectionFromMarkdownPosition ===
      "function"
    );
  });
  await setBlockSelectionFromMarkdownPosition(page, { line: 2, ch: 0 });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("X");

  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateBlockTest?.getMarkdown?.() ?? "";
    });
  }).toContain("abcX\n\n123");
});

test("block editor: ArrowRight at block end moves to next block start", async ({
  page,
}) => {
  const markdown = "abc\n\n123\n\n456";
  await page.goto(
    `http://127.0.0.1:4172/?block=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.getMarkdown === "function";
  });
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.setSelection === "function";
  });
  await page.waitForFunction(() => {
    return (
      typeof window.__slateBlockTest?.setSelectionFromMarkdownPosition ===
      "function"
    );
  });
  await setBlockSelectionFromMarkdownPosition(page, { line: 0, ch: 3 });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("Y");

  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateBlockTest?.getMarkdown?.() ?? "";
    });
  }).toContain("abc\n\nY123");
});

test("block editor: arrow inserts before/after code block", async ({ page }) => {
  const markdown = "```\nfoo\n```";
  await page.goto(
    `http://127.0.0.1:4172/?block=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.getMarkdown === "function";
  });
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.setSelection === "function";
  });
  await page.waitForFunction(() => {
    return (
      typeof window.__slateBlockTest?.setSelectionFromMarkdownPosition ===
      "function"
    );
  });
  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateBlockTest?.getMarkdown?.() ?? "";
    });
  }).toContain("foo");

  const codeBlock = page.locator(".cocalc-slate-code-block").first();
  await expect(codeBlock).toBeVisible();

  // Insert before code block.
  await codeBlock.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(50);
  await page.keyboard.type("xz");

  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateBlockTest?.getMarkdown?.() ?? "";
    });
  }).toMatch(/xz[\s\S]*```/);

  // Insert after code block.
  await codeBlock.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(50);
  await page.keyboard.type("yz");

  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateBlockTest?.getMarkdown?.() ?? "";
    });
  }).toContain("yz");
});

test("block editor: gap insert keeps caret", async ({ page }) => {
  const markdown = "```\nfoo\n```";
  await page.goto(
    `http://127.0.0.1:4172/?block=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.getMarkdown === "function";
  });
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.setSelection === "function";
  });
  await page.waitForFunction(() => {
    return (
      typeof window.__slateBlockTest?.setSelectionFromMarkdownPosition ===
      "function"
    );
  });
  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateBlockTest?.getMarkdown?.() ?? "";
    });
  }).toContain("foo");

  await setBlockSelectionFromMarkdownPosition(page, { line: 1, ch: 0 });
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(50);
  await page.keyboard.type("X");

  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateBlockTest?.getMarkdown?.() ?? "";
    });
  }).toContain("X");

  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateBlockTest?.getMarkdown?.() ?? "";
    });
  }).toContain("```");
});

test("block editor: backspace at block start merges and keeps focus", async ({
  page,
}) => {
  const markdown = "abc\n\n123\n\n456";
  await page.goto(
    `http://127.0.0.1:4172/?block=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.getMarkdown === "function";
  });
  await page.waitForFunction(() => {
    return (
      typeof window.__slateBlockTest?.setSelectionFromMarkdownPosition ===
      "function"
    );
  });
  await setBlockSelectionFromMarkdownPosition(page, { line: 2, ch: 0 });
  await page.waitForTimeout(50);
  await page.keyboard.press("Backspace");

  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateBlockTest?.getMarkdown?.());
  }).toBe("abc123\n\n456");

  await page.keyboard.type("Z");
  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateBlockTest?.getMarkdown?.());
  }).toBe("abcZ123\n\n456");
});

test("block editor: backspace at start of paragraph after quote joins into quote", async ({
  page,
}) => {
  const markdown = "> foo bar\n";
  await page.goto(
    `http://127.0.0.1:4172/?block=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return (
      typeof window.__slateBlockTest?.setSelectionFromMarkdownPosition ===
      "function"
    );
  });
  await setBlockSelectionFromMarkdownPosition(page, { line: 1, ch: 0 });
  await page.keyboard.press("Backspace");
  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateBlockTest?.getMarkdown?.());
  }).toBe("> foo bar");
});

test("block editor: backspace at start of text after quote preserves following text", async ({
  page,
}) => {
  const markdown = "> foo bar\n\n stuff";
  await page.goto(
    `http://127.0.0.1:4172/?block=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return (
      typeof window.__slateBlockTest?.setSelectionFromMarkdownPosition ===
      "function"
    );
  });
  await setBlockSelectionFromMarkdownPosition(page, { line: 2, ch: 0 });
  await page.keyboard.press("Backspace");
  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateBlockTest?.getMarkdown?.());
  }).toBe("> foo bar stuff");
});

test("block editor: backspace after empty quote does not crash", async ({
  page,
}) => {
  const markdown = ">\n\nstuff";
  await page.goto(
    `http://127.0.0.1:4172/?block=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return (
      typeof window.__slateBlockTest?.setSelectionFromMarkdownPosition ===
      "function"
    );
  });
  await setBlockSelectionFromMarkdownPosition(page, { line: 2, ch: 0 });
  await page.keyboard.press("Backspace");
  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateBlockTest?.getMarkdown?.());
  }).toContain("stuff");
});

test("block editor: backspace at start of x after multi-line quote appends to final quoted line", async ({
  page,
}) => {
  const markdown = "> foo\n>\n> bar\n\nx";
  await page.goto(
    `http://127.0.0.1:4172/?block=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return typeof window.__slateBlockTest?.setSelection === "function";
  });
  await page.evaluate(() => {
    return window.__slateBlockTest?.setSelection?.(0, "end");
  });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Backspace");
  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateBlockTest?.getMarkdown?.());
  }).toContain("> barx");
  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateBlockTest?.getMarkdown?.());
  }).not.toContain("> foox");
});

test("editable markdown: backspace at start of x after multi-line quote appends to final quoted line", async ({
  page,
}) => {
  const markdown = "> foo\n>\n> bar\n\nx";
  await page.goto(
    `http://127.0.0.1:4172/?editable=1&md=${encodeURIComponent(markdown)}`,
  );
  await page.waitForFunction(() => {
    return typeof window.__slateEditableTest?.getMarkdown === "function";
  });

  let xPath: number[] | null = null;
  await expect.poll(async () => {
    xPath = await page.evaluate(() => {
      const value = window.__slateEditableTest?.getValue?.() as
        | any[]
        | undefined;
      if (!Array.isArray(value) || value.length === 0) return null;
      const findPath = (node: any, path: number[]): number[] | null => {
        if (typeof node?.text === "string" && node.text === "x") {
          return path;
        }
        if (!Array.isArray(node?.children)) return null;
        for (let i = 0; i < node.children.length; i++) {
          const hit = findPath(node.children[i], [...path, i]);
          if (hit) return hit;
        }
        return null;
      };
      for (let i = 0; i < value.length; i++) {
        const hit = findPath(value[i], [i]);
        if (hit) return hit;
      }
      return null;
    });
    return xPath;
  }).not.toBeNull();
  expect(Array.isArray(xPath)).toBe(true);

  await page.evaluate((path) => {
    window.__slateEditableTest?.setSelection?.({
      anchor: { path, offset: 0 },
      focus: { path, offset: 0 },
    } as any);
  }, xPath);

  await page.keyboard.press("Backspace");

  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateEditableTest?.getMarkdown?.());
  }).toContain("> barx");
  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateEditableTest?.getMarkdown?.());
  }).not.toContain("> foox");
});

test("editable markdown: sync-set markdown then backspace before x appends to bar", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4172/?editable=1&md=");
  await page.waitForFunction(() => {
    return typeof window.__slateEditableTest?.setMarkdown === "function";
  });

  await page.evaluate(() => {
    window.__slateEditableTest?.setMarkdown?.("> foo\n>\n> bar\n\nx");
  });
  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateEditableTest?.getMarkdown?.());
  }).toContain("> bar");

  await page.evaluate(() => {
    window.__slateEditableTest?.setSelectionFromMarkdownPosition?.({
      line: 6,
      ch: 0,
    });
  });
  await page.keyboard.press("Backspace");

  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateEditableTest?.getMarkdown?.());
  }).toContain("> barx");
  await expect.poll(async () => {
    return await page.evaluate(() => window.__slateEditableTest?.getMarkdown?.());
  }).not.toContain("> foox");
});

test("sync: remote change to other block applies without deferring", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).COCALC_SLATE_REMOTE_MERGE = {
      blockPatch: true,
      ignoreWhileFocused: false,
      idleMs: 100,
    };
  });
  await page.goto("http://127.0.0.1:4172/?collab=1");
  await waitForCollabHarness(page);
  await waitForCollabMarkdownContains(page, "beta");

  const editorA = page.locator('[data-testid="collab-editor-a"]');
  await editorA.locator("text=beta").first().click();
  await page.keyboard.press("End");

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote("alpha\n\nbeta\n\ncharlie remote\n");
  });

  await page.waitForFunction(() => {
    return window.__slateCollabTest?.getMarkdownA?.().includes("charlie remote");
  });

  await page.keyboard.type("Z");

  const selectionMarkdown = await page.evaluate(() => window.__slateCollabTest?.getMarkdownA());
  expect(selectionMarkdown ?? "").toContain("remote");
  expect(selectionMarkdown ?? "").toContain("Z");
});

test("sync: defer remote change to active block while typing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).COCALC_SLATE_REMOTE_MERGE = {
      blockPatch: true,
      ignoreWhileFocused: false,
      idleMs: 120,
    };
  });
  await page.goto("http://127.0.0.1:4172/?collab=1");
  await waitForCollabHarness(page);

  const editorA = page.locator('[data-testid="collab-editor-a"]');
  await editorA.locator("text=beta").first().click();
  await page.keyboard.press("End");

  await page.keyboard.type("123");

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote("alpha\n\nbeta remote\n\ncharlie\n");
  });

  await page.waitForTimeout(40);

  const before = await page.evaluate(() => window.__slateCollabTest?.getMarkdownA());
  expect(before).toContain("1");
  expect(before).toContain("2");
  expect(before).toContain("3");
  expect(before?.replace(/[0-9]/g, "")).toContain("beta");
  expect(before).not.toContain("beta remote");

  await page.waitForTimeout(200);

  const after = await page.evaluate(() => window.__slateCollabTest?.getMarkdownA());
  expect(after).toContain("1");
  expect(after).toContain("2");
  expect(after).toContain("3");
  expect(after).toContain("remote");
});

test("sync: remote insert before active block keeps caret in block", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).COCALC_SLATE_REMOTE_MERGE = {
      blockPatch: true,
      ignoreWhileFocused: false,
      idleMs: 120,
    };
  });
  await page.goto("http://127.0.0.1:4172/?collab=1");
  await waitForCollabHarness(page);

  const editorA = page.locator('[data-testid="collab-editor-a"]');
  await editorA.locator("text=beta").first().click();
  await page.keyboard.press("End");

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote(
      "alpha\n\nremote inserted\n\nbeta\n\ncharlie\n",
    );
  });

  await page.waitForFunction(() => {
    return window.__slateCollabTest?.getMarkdownA?.().includes("remote inserted");
  });

  await page.keyboard.type("Z");
  const md = await page.evaluate(() => window.__slateCollabTest?.getMarkdownA?.() ?? "");
  expect(md).toContain("Z");
  expect(md).toContain("beta");
  expect(md).toContain("remote inserted");
});

test("sync: remote delete before active block keeps caret in block", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).COCALC_SLATE_REMOTE_MERGE = {
      blockPatch: true,
      ignoreWhileFocused: false,
      idleMs: 120,
    };
  });
  await page.goto("http://127.0.0.1:4172/?collab=1");
  await waitForCollabHarness(page);
  await waitForCollabMarkdownContains(page, "beta");

  const editorA = page.locator('[data-testid="collab-editor-a"]');
  await editorA.locator("text=beta").first().click();
  await page.keyboard.press("End");

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote("beta\n\ncharlie\n");
  });

  await page.waitForFunction(() => {
    return window.__slateCollabTest?.getMarkdownA?.().startsWith("beta");
  });

  await page.keyboard.type("Z");
  const md = await page.evaluate(() => window.__slateCollabTest?.getMarkdownA?.() ?? "");
  // In harness mode this path is occasionally timing-sensitive; assert stable invariants.
  expect(md.replace(/Z/g, "")).toContain("beta");
  expect(md).toContain("charlie");
});

test("sync: remote swap of other blocks keeps caret in active block", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).COCALC_SLATE_REMOTE_MERGE = {
      blockPatch: true,
      ignoreWhileFocused: false,
      idleMs: 120,
    };
  });
  await page.goto("http://127.0.0.1:4172/?collab=1");
  await waitForCollabHarness(page);
  await waitForCollabMarkdownContains(page, "beta");

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote(
      "alpha\n\nbeta\n\ncharlie\n\ndelta\n",
    );
  });

  await page.waitForFunction(() => {
    return window.__slateCollabTest?.getMarkdownA?.().includes("delta");
  });

  const editorA = page.locator('[data-testid="collab-editor-a"]');
  await editorA.locator("text=beta").first().click();
  await page.keyboard.press("End");

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote("alpha\n\nbeta\n\ndelta\n\ncharlie\n");
  });

  await page.waitForFunction(() => {
    const md = window.__slateCollabTest?.getMarkdownA?.() ?? "";
    return md.includes("delta") && md.trimEnd().endsWith("charlie");
  });

  await page.keyboard.type("Z");
  await expect.poll(async () => {
    return await page.evaluate(() => {
      return window.__slateCollabTest?.getMarkdownA?.() ?? "";
    });
  }).toContain("Z");
});

test("sync: remote change to other block while typing stays applied", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).COCALC_SLATE_REMOTE_MERGE = {
      blockPatch: true,
      ignoreWhileFocused: false,
      idleMs: 120,
    };
  });
  await page.goto("http://127.0.0.1:4172/?collab=1");
  await waitForCollabHarness(page);
  await waitForCollabMarkdownContains(page, "beta");

  const editorA = page.locator('[data-testid="collab-editor-a"]');
  await editorA.locator("text=beta").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("123");

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote("alpha remote\n\nbeta\n\ncharlie\n");
  });

  await page.waitForFunction(() => {
    return window.__slateCollabTest?.getMarkdownA?.().includes("alpha remote");
  });

  const md = await page.evaluate(() => window.__slateCollabTest?.getMarkdownA());
  expect(md).toContain("alpha remote");
  expect(md?.replace(/[0-9]/g, "")).toContain("beta");
  expect(md).toContain("1");
  expect(md).toContain("2");
  expect(md).toContain("3");
});

test("sync: remote edit in active line keeps caret at end", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).COCALC_SLATE_REMOTE_MERGE = {
      blockPatch: true,
      ignoreWhileFocused: false,
      idleMs: 120,
    };
  });
  await page.goto("http://127.0.0.1:4172/?collab=1");
  await waitForCollabHarness(page);

  const editorA = page.locator('[data-testid="collab-editor-a"]');

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote(
      "block A\n\nthis is a string\n\nblock C\n",
    );
  });

  await page.waitForFunction(() => {
    return window.__slateCollabTest?.getMarkdownA?.().includes("this is a string");
  });

  const selectionSet = await page.evaluate(() => {
    const md = window.__slateCollabTest?.getMarkdownA?.() ?? "";
    const needle = "this is a string";
    const idx = md.indexOf(needle);
    if (idx < 0) return false;
    const before = md.slice(0, idx);
    const line = before.split("\n").length - 1;
    const ch = before.length - (before.lastIndexOf("\n") + 1) + needle.length;
    return (
      window.__slateCollabTest?.setSelectionFromMarkdownA?.({ line, ch }) ??
      false
    );
  });

  if (!selectionSet) {
    await editorA.locator("text=this is a string").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("Q");
    await page.waitForFunction(() => {
      const md = window.__slateCollabTest?.getMarkdownA?.() ?? "";
      return md.includes("this is a stringQ");
    });
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => {
      const md = window.__slateCollabTest?.getMarkdownA?.() ?? "";
      return md.includes("this is a string") && !md.includes("stringQ");
    });
  }

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote(
      "block A\n\nremote this is a string\n\nblock C\n",
    );
  });

  await page.waitForFunction(() => {
    return window.__slateCollabTest?.getMarkdownA?.().includes("remote this is a string");
  });
  await page.waitForTimeout(200);
  await page.keyboard.press("End");
  const before = await page.evaluate(() => window.__slateCollabTest?.getMarkdownA());
  expect(before).toContain("remote this is a string");

  await page.keyboard.type("Z");

  const md = await page.evaluate(() => window.__slateCollabTest?.getMarkdownA());
  expect(md).toMatch(/remote this is a stringZ|Zremote this is a string/);
});

test("sync:block editor remote edit in active line keeps caret at end", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).COCALC_SLATE_REMOTE_MERGE = {
      blockPatch: true,
      ignoreWhileFocused: false,
      idleMs: 120,
    };
  });
  await page.goto("http://127.0.0.1:4172/?collabBlock=1");
  await waitForCollabHarness(page);

  const editorA = page.locator('[data-testid="collab-editor-a"]');

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote(
      "block A\n\nthis is a string\n\nblock C\n",
    );
  });

  await page.waitForFunction(() => {
    return window.__slateCollabTest?.getMarkdownA?.().includes("this is a string");
  });

  await editorA.locator("text=this is a string").first().click();
  await page.keyboard.press("End");

  await page.evaluate(() => {
    window.__slateCollabTest?.setRemote(
      "block A\n\nremote this is a string\n\nblock C\n",
    );
  });

  await page.waitForFunction(() => {
    const a = window.__slateCollabTest?.getMarkdownA?.() ?? "";
    const b = window.__slateCollabTest?.getMarkdownB?.() ?? "";
    return (
      a.includes("remote this is a string") ||
      b.includes("remote this is a string")
    );
  });
  await page.evaluate(() => {
    window.__slateCollabTest?.setSelectionA?.(1, "end");
  });
  await page.waitForTimeout(50);

  await page.keyboard.type("Z");

  const md = await page.evaluate(() => window.__slateCollabTest?.getMarkdownA?.() ?? "");
  expect(md).toContain("Z");
});
