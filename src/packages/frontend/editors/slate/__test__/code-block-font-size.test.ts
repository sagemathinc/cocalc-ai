import { CODE_BLOCK_TEXTAREA_STYLE } from "../elements/code-block";

describe("Slate code block font sizing", () => {
  test("editable code blocks inherit the surrounding editor font size", () => {
    expect(CODE_BLOCK_TEXTAREA_STYLE.fontSize).toBe("inherit");
  });
});
