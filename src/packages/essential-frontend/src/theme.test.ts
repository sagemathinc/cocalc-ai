/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  essentialThemeStyle,
  parseEssentialThemePreference,
  resolveEssentialTheme,
} from "./theme";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("stylesheet owns complete paired palettes without runtime palette objects", () => {
  const element = document.createElement("style");
  element.textContent = readFileSync(join(__dirname, "styles.css"), "utf8");
  document.head.appendChild(element);
  try {
    const rules = Array.from(element.sheet!.cssRules) as CSSStyleRule[];
    const light = rules.find(
      (rule) => rule.selectorText === '.ul-app[data-ul-theme="light"]',
    )!.style;
    const dark = rules.find(
      (rule) => rule.selectorText === '.ul-app[data-ul-theme="dark"]',
    )!.style;
    const keys = (style: CSSStyleDeclaration) =>
      Array.from({ length: style.length }, (_, i) => style[i]).sort();
    expect(keys(dark)).toEqual(keys(light));
    expect(light.getPropertyValue("--ul-bg")).toBe("white");
    expect(dark.getPropertyValue("--ul-bg")).toBe("#303030");
    expect(dark.getPropertyValue("--ul-ink")).toBe("#eeeeee");
    expect(light.getPropertyValue("color-scheme")).toBe("light");
    expect(dark.getPropertyValue("color-scheme")).toBe("dark");
  } finally {
    element.remove();
  }
});

test("parses only explicit stored overrides", () => {
  expect(parseEssentialThemePreference("light")).toBe("light");
  expect(parseEssentialThemePreference("dark")).toBe("dark");
  expect(parseEssentialThemePreference("system")).toBe("system");
  expect(parseEssentialThemePreference("unexpected")).toBe("system");
  expect(parseEssentialThemePreference(null)).toBe("system");
});

test("resolves system preference without changing explicit overrides", () => {
  expect(resolveEssentialTheme("system", true)).toBe("dark");
  expect(resolveEssentialTheme("system", false)).toBe("light");
  expect(resolveEssentialTheme("light", true)).toBe("light");
  expect(resolveEssentialTheme("dark", false)).toBe("dark");
  expect(essentialThemeStyle("dark")).toEqual(
    expect.objectContaining({ colorScheme: "dark" }),
  );
});
