import fixedElements from "./fixed-elements";
import { SLIDE_TEMPLATE_ELEMENTS } from "./template";

describe("slides fixed elements", () => {
  it("centers the fixed slide background around the origin", () => {
    const slide = fixedElements["the-slide"];
    expect(slide.x).toBe(-(slide.w ?? 0) / 2);
    expect(slide.y).toBe(-(slide.h ?? 0) / 2);
  });

  it("keeps the default title and subtitle template inside the slide", () => {
    const slide = fixedElements["the-slide"];
    const slideLeft = slide.x;
    const slideTop = slide.y;
    const slideRight = slide.x + slide.w;
    const slideBottom = slide.y + slide.h;

    for (const element of SLIDE_TEMPLATE_ELEMENTS) {
      expect(element.x).toBeGreaterThanOrEqual(slideLeft);
      expect(element.y).toBeGreaterThanOrEqual(slideTop);
      expect(element.x + element.w).toBeLessThanOrEqual(slideRight);
      expect(element.y + element.h).toBeLessThanOrEqual(slideBottom);
    }
  });
});
