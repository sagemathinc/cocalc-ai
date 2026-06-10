import fixedElements, {
  LEGACY_SLIDE_LEFT,
  LEGACY_SLIDE_TOP,
} from "./fixed-elements";
import { SLIDE_TEMPLATE_ELEMENTS } from "./template";

describe("slides fixed elements", () => {
  it("keeps the fixed slide background at the legacy CoCalc position", () => {
    const slide = fixedElements["the-slide"];
    expect(slide.x).toBe(LEGACY_SLIDE_LEFT);
    expect(slide.y).toBe(LEGACY_SLIDE_TOP);
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

  it("uses plain styled text for editable title and subtitle placeholders", () => {
    for (const element of SLIDE_TEMPLATE_ELEMENTS) {
      expect(element.data?.placeholder).not.toContain("#");
      expect(element.data?.initStr).toBeUndefined();
      expect(element.data?.color).toBeTruthy();
      expect(element.data?.fontSize).toBeGreaterThan(20);
    }
  });
});
