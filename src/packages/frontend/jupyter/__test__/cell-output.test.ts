import { outputMinHeight } from "../cell-output";

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
});
