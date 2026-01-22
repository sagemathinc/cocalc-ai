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
