/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

import { render } from "@testing-library/react";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import HtmlOutput from "./html-output";
import IFrame from "./iframe";
import { FRAME_THEME_HEAD, withFrameTheme } from "./frame-theme";

jest.mock("./use-blob", () => ({
  __esModule: true,
  default: () => '<p style="color:red" id="from-blob">blob</p>',
}));

// What a trusted notebook used to provide to its outputs.
function renderTrusted(ui) {
  return render(
    <FileContext.Provider value={{ noSanitize: true }}>
      {ui}
    </FileContext.Provider>,
  );
}

function frames(container: HTMLElement): HTMLIFrameElement[] {
  return Array.from(container.querySelectorAll("iframe"));
}

describe("HtmlOutput", () => {
  it("renders faithful HTML inline and sanitized, even when trusted", () => {
    const { container } = renderTrusted(
      <HtmlOutput value='<b class="app-class">x</b>' />,
    );
    const b = container.querySelector("b");
    expect(b?.textContent).toBe("x");
    // noSanitize would have kept the class
    expect(b?.hasAttribute("class")).toBe(false);
    expect(frames(container)).toHaveLength(0);
  });

  it.each([
    ['<span style="position:fixed;inset:0">x</span>'],
    ["<style>body{display:none}</style><p>x</p>"],
    ['<img src=x onerror="parent.document.title=1">'],
    ["<script>parent.document.title=1</script>"],
  ])("renders %s only in an opaque frame, even when trusted", (html) => {
    const { container } = renderTrusted(<HtmlOutput value={html} />);
    const [frame, ...rest] = frames(container);
    expect(rest).toHaveLength(0);
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-forms allow-scripts allow-presentation",
    );
    expect(frame.getAttribute("srcdoc")).toContain(html);
    expect(frame.getAttribute("srcdoc")).toContain(FRAME_THEME_HEAD);
    // nothing of the content outside the frame
    expect(container.querySelector("span, style, img, script, p")).toBeNull();
  });

  it("renders blob-stored HTML the same way, trusted or not", () => {
    for (const trust of [true, false]) {
      const { container, unmount } = renderTrusted(
        <IFrame sha1="abc" trust={trust} />,
      );
      expect(container.querySelector("#from-blob")).toBeNull();
      const [frame] = frames(container);
      expect(frame.getAttribute("sandbox")).toBe(
        "allow-forms allow-scripts allow-presentation",
      );
      expect(frame.getAttribute("srcdoc")).toContain('id="from-blob"');
      unmount();
    }
  });
});

describe("withFrameTheme", () => {
  // Prepended, never inserted: "<head>" or "</body>" may be inside a script.
  it.each([
    ["<p>x</p>"],
    ['<html lang="en"><head><style>p{}</style></head><body>x</body></html>'],
    ['<script>var s = "<head>";</script><div>x</div>'],
  ])("puts the theme before %s", (html) => {
    expect(withFrameTheme(html)).toBe(FRAME_THEME_HEAD + html);
  });
});
