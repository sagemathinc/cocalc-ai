import { getFontSizeDeltaFromKey } from "../keyboard/font-size-shortcut";

test("getFontSizeDeltaFromKey handles shifted symbols", () => {
  expect(getFontSizeDeltaFromKey(">", true)).toBe(1);
  expect(getFontSizeDeltaFromKey(".", true)).toBe(1);
  expect(getFontSizeDeltaFromKey("<", true)).toBe(-1);
  expect(getFontSizeDeltaFromKey(",", true)).toBe(-1);
});

test("getFontSizeDeltaFromKey ignores unrelated keys", () => {
  expect(getFontSizeDeltaFromKey("a", false)).toBeNull();
  expect(getFontSizeDeltaFromKey(".", false)).toBeNull();
  expect(getFontSizeDeltaFromKey(",", false)).toBeNull();
});
