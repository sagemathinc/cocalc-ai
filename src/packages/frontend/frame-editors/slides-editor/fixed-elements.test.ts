import fixedElements from "./fixed-elements";

describe("slides fixed elements", () => {
  it("centers the fixed slide background around the origin", () => {
    const slide = fixedElements["the-slide"];
    expect(slide.x).toBe(-(slide.w ?? 0) / 2);
    expect(slide.y).toBe(-(slide.h ?? 0) / 2);
  });
});
