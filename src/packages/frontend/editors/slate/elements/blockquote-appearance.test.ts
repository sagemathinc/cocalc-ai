/** @jest-environment jsdom */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  darkAppearance,
  lightAppearance,
} from "@cocalc/util/appearance-palette";

function luminance(hex: string) {
  let value = hex.slice(1);
  if (value.length === 3) value = [...value].map((x) => x + x).join("");
  const rgb = [0, 2, 4].map((i) => {
    const c = parseInt(value.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

it("uses theme-aware blockquote defaults while preserving local overrides", () => {
  const sheet = document.createElement("style");
  sheet.textContent = readFileSync(join(__dirname, "elements.css"), "utf8");
  document.head.appendChild(sheet);
  try {
    const rule = [...sheet.sheet!.cssRules].find((rule) =>
      (rule as CSSStyleRule).selectorText?.endsWith(".cocalc-slate-blockquote"),
    ) as CSSStyleRule;
    expect(
      rule.style.getPropertyValue("border-left").replace(/\s/g, ""),
    ).toContain(
      "var(--cocalc-slate-blockquote-border,var(--cocalc-ui-controlBorder,",
    );
    expect(
      rule.style.getPropertyValue("background").replace(/\s/g, ""),
    ).toContain("var(--cocalc-slate-blockquote-bg,var(--cocalc-ui-hover,");
  } finally {
    sheet.remove();
  }
});

it.each([lightAppearance, darkAppearance])(
  "keeps the quote boundary and text distinct in each palette",
  (palette) => {
    expect(
      contrast(palette.controlBorder, palette.hover),
    ).toBeGreaterThanOrEqual(3);
    expect(contrast(palette.text, palette.hover)).toBeGreaterThanOrEqual(4.5);
    expect(palette.hover).not.toBe(palette.surface);
    expect(palette.hover).not.toBe(palette.page);
  },
);
