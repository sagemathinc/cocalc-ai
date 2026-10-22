import {
  CHAT_IMAGE_BOX_HEIGHT,
  clearRowHeights,
  estimateMessageRowHeight,
  rememberedRowHeight,
  rememberRowHeight,
} from "../row-height-estimates";

beforeEach(() => clearRowHeights());

test("measured heights are remembered per chat", () => {
  rememberRowHeight("chat-a", "row-1", 120);
  rememberRowHeight("chat-b", "row-1", 300);
  expect(rememberedRowHeight("chat-a", "row-1")).toBe(120);
  expect(rememberedRowHeight("chat-b", "row-1")).toBe(300);
  expect(rememberedRowHeight("chat-a", "row-2")).toBeUndefined();
  // Nothing for a row that was never drawn (height 0).
  rememberRowHeight("chat-a", "row-3", 0);
  expect(rememberedRowHeight("chat-a", "row-3")).toBeUndefined();
});

test("only the most recent chats are kept", () => {
  for (let i = 0; i < 60; i++) rememberRowHeight(`chat-${i}`, "r", 10 + i);
  expect(rememberedRowHeight("chat-0", "r")).toBeUndefined();
  expect(rememberedRowHeight("chat-59", "r")).toBe(69);
});

test("estimates grow with text and with images", () => {
  const short = estimateMessageRowHeight("hi");
  const long = estimateMessageRowHeight("word ".repeat(400));
  const image = estimateMessageRowHeight("look: ![](https://x/y.png)");
  expect(long).toBeGreaterThan(short);
  expect(image - short).toBeGreaterThanOrEqual(CHAT_IMAGE_BOX_HEIGHT);
  expect(estimateMessageRowHeight(undefined)).toBe(short - 0);
  expect(estimateMessageRowHeight("x\n".repeat(100_000))).toBe(20_000);
});

test("a remembered height counts only for the same content and layout", () => {
  rememberRowHeight("chat", "row", 900, { content: "1200", layout: "14|20" });
  expect(
    rememberedRowHeight("chat", "row", { content: "1200", layout: "14|20" }),
  ).toBe(900);
  // Edited: another length.
  expect(
    rememberedRowHeight("chat", "row", { content: "40", layout: "14|20" }),
  ).toBeUndefined();
  // Wider, or another font size.
  expect(
    rememberedRowHeight("chat", "row", { content: "1200", layout: "14|30" }),
  ).toBeUndefined();
  // Layout not known yet (the list is not laid out): content alone.
  expect(rememberedRowHeight("chat", "row", { content: "1200" })).toBe(900);
});
