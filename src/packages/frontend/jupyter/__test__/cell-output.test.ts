import { OUTPUT_COLUMN_STYLE, outputMinHeight } from "../cell-output";
import { OUTPUT_STYLE, OUTPUT_STYLE_SCROLLED } from "../output-messages/style";

describe("Jupyter cell output height policy", () => {
  it("does not preserve live full-output height after switching to scrolled output", () => {
    expect(
      outputMinHeight({
        complete: false,
        running: true,
        scrolled: true,
        stableOutputHeight: 1200,
      }),
    ).toBeUndefined();
  });

  it("keeps stable live output height for unscrolled running output", () => {
    expect(
      outputMinHeight({
        complete: false,
        running: true,
        scrolled: false,
        stableOutputHeight: 1200,
      }),
    ).toBe("1200px");
  });

  it("keeps the completion placeholder height", () => {
    expect(
      outputMinHeight({
        complete: true,
        running: true,
        scrolled: true,
        stableOutputHeight: 1200,
      }),
    ).toBe("60vh");
  });

  it("allows the output column to shrink around long output lines", () => {
    expect(OUTPUT_COLUMN_STYLE).toMatchObject({
      flex: 1,
      minWidth: 0,
    });
    expect(OUTPUT_STYLE).toMatchObject({
      minWidth: 0,
      maxWidth: "100%",
      overflowX: "auto",
    });
  });

  it("keeps the vertical scrollbar on the scrolled output container", () => {
    expect(OUTPUT_STYLE_SCROLLED).toMatchObject({
      overflowX: "auto",
      overflowY: "auto",
      maxHeight: "max(24em,60vh)",
    });
  });
});
