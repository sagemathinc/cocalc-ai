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

  expect(value?.length).toBe(3);
  if (value) {
    expect(value[1]?.blank).toBe(true);
    expect(nodeText(value[2])).toBe("xyz");
  }

  let selection = (await page.evaluate(
    () => window.__slateTest?.getSelection(),
  )) as SlateSelection;

  expect(selection).not.toBeNull();
  if (selection) {
    expect(selection.anchor.path[0]).toBe(2);
    expect(selection.anchor.offset).toBe(0);
  }

  await page.keyboard.press("Enter");

  value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;

  expect(value?.length).toBe(4);
  if (value) {
    expect(value[1]?.blank).toBe(true);
    expect(value[2]?.blank).toBe(true);
    expect(nodeText(value[3])).toBe("xyz");
  }

  selection = (await page.evaluate(
    () => window.__slateTest?.getSelection(),
  )) as SlateSelection;

  expect(selection).not.toBeNull();
  if (selection) {
    expect(selection.anchor.path[0]).toBe(3);
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

test("autoformat quotes the current paragraph when typing > at start", async ({
  page,
}) => {
  await page.goto("/");
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

  const value = (await page.evaluate(
    () => window.__slateTest?.getValue(),
  )) as SlateNode[] | undefined;

  expect(value?.length).toBe(1);
  if (value) {
    expect(value[0]?.type).toBe("blockquote");
    expect(nodeText(value[0])).toBe("quote me");
  }
});
