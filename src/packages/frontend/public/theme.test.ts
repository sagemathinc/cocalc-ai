/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  alpha,
  getPublicColors,
  PUBLIC_COLORS,
  PUBLIC_DARK,
  PUBLIC_ELEVATION,
  PUBLIC_THEME_CSS,
} from "./theme";

test("public UI has complete paired palettes and concrete algorithm colors", () => {
  const light = getPublicColors("light");
  const dark = getPublicColors("dark");
  expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  for (const [name, value] of Object.entries(light)) {
    expect(value).not.toContain("var(");
    expect(dark[name]).not.toContain("var(");
    expect(PUBLIC_COLORS[name]).toBe(`var(--cocalc-public-${name})`);
    expect(PUBLIC_THEME_CSS).toContain(`--cocalc-public-${name}:${value}`);
    expect(PUBLIC_THEME_CSS).toContain(`--cocalc-public-${name}:${dark[name]}`);
  }
  for (const role of ["text", "heading", "surface", "pageBackground", "link"]) {
    expect(light[role]).not.toBe(dark[role]);
  }
  expect(PUBLIC_THEME_CSS).toContain("@media(prefers-color-scheme:dark)");
  expect(PUBLIC_THEME_CSS).toContain("@media print");
});

test("fixed artwork is independent of the page, with readable hero text", () => {
  expect(getPublicColors("light").heroBackground).toBe(
    getPublicColors("dark").heroBackground,
  );
  expect(getPublicColors("light").onPrimary).toBe(
    getPublicColors("dark").onPrimary,
  );
  expect(PUBLIC_DARK.terminalSurface).not.toContain("var(");
});

test("alpha supports semantic colors without breaking existing literal users", () => {
  expect(alpha("#123456", 0.5)).toBe("rgba(18, 52, 86, 0.5)");
  expect(alpha(PUBLIC_COLORS.shadowInk, 0.1)).toBe(
    "color-mix(in srgb, var(--cocalc-public-shadowInk) 10%, transparent)",
  );
  expect(PUBLIC_ELEVATION.sm).toContain("--cocalc-public-shadowInk");
});
