/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  essentialThemeStyle,
  parseEssentialThemePreference,
  resolveEssentialTheme,
} from "./theme";

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
