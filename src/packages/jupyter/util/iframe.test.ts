/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { shouldIsolateHtmlOutput, shouldUseIframe } from "./iframe";

describe("Jupyter HTML iframe isolation", () => {
  it("does not isolate ordinary HTML", () => {
    expect(shouldIsolateHtmlOutput("<table><tr><td>x</td></tr></table>")).toBe(
      false,
    );
  });

  it("does not wrap top-level iframe snippets in another iframe", () => {
    expect(
      shouldIsolateHtmlOutput(
        '<iframe src="https://example.com" width="400" height="200"></iframe>',
      ),
    ).toBe(false);
  });

  it("isolates full HTML documents", () => {
    expect(
      shouldIsolateHtmlOutput("<!doctype html><html><body>x</body></html>"),
    ).toBe(true);
    expect(shouldIsolateHtmlOutput("<html><body>x</body></html>")).toBe(true);
  });

  it("isolates Plotly-like and huge HTML output", () => {
    expect(shouldIsolateHtmlOutput("<script>PlotlyEnv={}</script>")).toBe(true);
    expect(shouldIsolateHtmlOutput("x".repeat(1_000_000))).toBe(true);
  });

  it("keeps the legacy backend predicate aligned", () => {
    expect(shouldUseIframe("<table><tr><td>x</td></tr></table>")).toBe(false);
    expect(shouldUseIframe("<html><body>x</body></html>")).toBe(true);
  });
});
