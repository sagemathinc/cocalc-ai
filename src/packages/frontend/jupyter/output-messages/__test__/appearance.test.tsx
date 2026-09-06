import { render, screen } from "@testing-library/react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { Image } from "../image";
import { OUTPUT_STYLE, OUTPUT_STYLE_SCROLLED, TRACEBACK_STYLE } from "../style";

it("pairs text and backgrounds for normal, scrolled and error output", () => {
  for (const style of [OUTPUT_STYLE, OUTPUT_STYLE_SCROLLED]) {
    expect(style.backgroundColor).toBe(UI_COLORS.surface);
    expect(style.color).toBe(UI_COLORS.text);
  }
  expect(TRACEBACK_STYLE.backgroundColor).toBe(UI_COLORS.dangerBg);
  expect(TRACEBACK_STYLE.color).toBe(UI_COLORS.text);
});

it("preserves plot image content and paper backing without inversion", () => {
  render(
    <Image
      type="image/svg+xml"
      value='<svg xmlns="http://www.w3.org/2000/svg" />'
    />,
  );
  const image = screen.getByRole("img", { name: "Jupyter output" });
  expect(image.style.backgroundColor).toBe("white");
  expect(image.style.filter).toBe("");
  expect(image.getAttribute("src")).toContain("data:image/svg+xml;utf8,");
});
