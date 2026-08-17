/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { renderEssentialShell } from "./essential-shell";

test("anchors relative Essential chunks at the static deployment path", () => {
  expect(
    renderEssentialShell(
      '<!doctype html><html><head><script src="essential.js"></script></head></html>',
      "/cocalc/static",
    ),
  ).toContain('<head><base href="/cocalc/static/"><script src="essential.js">');
});

test("requires a valid HTML shell", () => {
  expect(() => renderEssentialShell("not html", "/static/")).toThrow(
    "no head element",
  );
});
