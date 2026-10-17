/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  isAllowedHtmlTag,
  isSafeImageUrl,
  sanitizeHtmlAttributes,
} from "./sanitize-html";
import { sanitizeInlineStyle } from "./sanitize-presentation";

describe("sanitizeInlineStyle", () => {
  it.each([
    ["color: red", "color: red"],
    ["color:rgb(0, 128, 0);", "color: rgb(0, 128, 0)"],
    [
      "background-color: #ff0; font-weight: bold; text-align: center",
      "background-color: #ff0; font-weight: bold; text-align: center",
    ],
    [
      "border: 1px solid black; padding: 4px 8px",
      "border: 1px solid black; padding: 4px 8px",
    ],
    [
      "background: linear-gradient(red, blue)",
      "background: linear-gradient(red, blue)",
    ],
    ["width: calc(100% - 2em)", "width: calc(100% - 2em)"],
    [
      "font-family: 'Comic Sans MS', serif",
      "font-family: 'Comic Sans MS', serif",
    ],
    ["display: inline-block", "display: inline-block"],
    ["margin: 0 auto", "margin: 0 auto"],
    ["COLOR: Red", "color: Red"],
  ])("keeps %s", (style, kept) => {
    expect(sanitizeInlineStyle(style)).toBe(kept);
  });

  it.each([
    // covering the app
    ["position: fixed; inset: 0"],
    ["position:absolute;top:0;left:0"],
    ["z-index: 99999"],
    ["transform: translate(-500px, -500px)"],
    ["margin-top: -1000px"],
    ["margin: 0 0 0 -50%"],
    ["margin-left: calc(0px - 100vw)"],
    ["text-indent: -9999px"],
    // loading resources
    ["background: url(https://evil.example/x.png)"],
    ["background: URL( 'https://evil.example/x.png' )"],
    ["background: image-set('x.png' 1x)"],
    ["list-style: url(x.png)"],
    ["background-image: linear-gradient(red, blue)"], // property not listed
    ["border-image: url(x) 30"],
    ["cursor: url(x), auto"],
    // indirection the sanitizer can't see through
    ["color: var(--cocalc-ui-text)"],
    ["color: env(safe-area-inset-top)"],
    ["background: u\\72l(x.png)"],
    ["background: red /* */ url(x)"],
    ["color: expression(alert(1))"],
    ["-moz-binding: url(x)"],
    ["behavior: url(x.htc)"],
    ["--x: red"],
    ["content: 'x'"],
    ["color: red !important"],
    ["display: contents"],
    ["color: red} body{display:none"],
    ["color: <script>"],
    ["pointer-events: none"],
    // paints outside its element
    ["text-shadow: 0 -345px 0 red"],
  ])("drops %s", (style) => {
    expect(sanitizeInlineStyle(style)).toBeUndefined();
  });

  // Cases only one rule rejects (no function, so the function allowlist
  // can't catch them).
  it.each([
    ["an escape", "font-family: \\41rial"],
    ["an escaped color name", "color: r\\65 d"],
    ["a comment", "color: red /* x */"],
    ["a comment opener", "font-family: a/*b"],
    ["a too-long value", `font-family: ${"a".repeat(301)}`],
  ])("drops a value with %s", (_, style) => {
    expect(sanitizeInlineStyle(style)).toBeUndefined();
  });

  it("drops a too-long style as a whole", () => {
    const style = "color: red; " + "font-weight: bold; ".repeat(300);
    expect(style.length).toBeGreaterThan(5000);
    expect(sanitizeInlineStyle(style)).toBeUndefined();
    expect(sanitizeInlineStyle("color: red; font-weight: bold")).toBe(
      "color: red; font-weight: bold",
    );
  });

  it("keeps the safe declarations of a mixed style", () => {
    expect(
      sanitizeInlineStyle(
        "color: green; position: fixed; background: url(x); font-size: 20px",
      ),
    ).toBe("color: green; font-size: 20px");
  });

  it("does not split inside quotes or parentheses", () => {
    // A ; in a value never starts a new declaration (and drops the value).
    expect(sanitizeInlineStyle("font-family: 'a;color:red'")).toBeUndefined();
    expect(sanitizeInlineStyle("width: calc(1px;color:red)")).toBeUndefined();
    expect(sanitizeInlineStyle("font-family: 'a;b'; color: blue")).toBe(
      "color: blue",
    );
  });
});

describe("data: images", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("are kept in img src and srcset (Jupyter attachments)", () => {
    expect(sanitizeHtmlAttributes("img", { src: PNG })).toEqual({ src: PNG });
    expect(
      sanitizeHtmlAttributes("img", { srcset: `${PNG} 2x` }).srcset,
    ).toContain(PNG);
    expect(isSafeImageUrl(" data:image/svg+xml;charset=utf-8,<svg/>")).toBe(
      true,
    );
  });

  it("are not kept anywhere else, and only images are", () => {
    expect(sanitizeHtmlAttributes("a", { href: PNG })).toEqual({});
    expect(sanitizeHtmlAttributes("iframe", { src: PNG })).toEqual({});
    for (const src of [
      "data:text/html,<script>alert(1)</script>",
      "data:,x",
      "data:image,x",
      "javascript:alert(1)",
    ]) {
      expect(isSafeImageUrl(src)).toBe(false);
      expect(sanitizeHtmlAttributes("img", { src })).toEqual({});
    }
  });
});

describe("sanitizeHtmlAttributes with safeStyles", () => {
  const safe = { safeStyles: true };

  it("keeps safe styles and presentational attributes only when opted in", () => {
    const attribs = {
      style: "color: red; position: fixed",
      class: "ant-modal",
      align: "center",
      onclick: "alert(1)",
    };
    expect(sanitizeHtmlAttributes("div", attribs)).toEqual({});
    expect(sanitizeHtmlAttributes("div", attribs, undefined, safe)).toEqual({
      style: "color: red",
      align: "center",
    });
  });

  it("validates presentational values", () => {
    expect(
      sanitizeHtmlAttributes(
        "td",
        {
          colspan: "2",
          rowspan: "x",
          bgcolor: "#ff0",
          width: "50%",
          align: "javascript:",
        },
        undefined,
        safe,
      ),
    ).toEqual({ colspan: "2", bgcolor: "#ff0", width: "50%" });
    expect(
      sanitizeHtmlAttributes(
        "font",
        { color: "red", face: "Arial", size: "+2" },
        undefined,
        safe,
      ),
    ).toEqual({ color: "red", face: "Arial", size: "+2" });
    expect(
      sanitizeHtmlAttributes(
        "font",
        { color: "url(x)", face: "a</font>", size: "99" },
        undefined,
        safe,
      ),
    ).toEqual({});
  });

  it("still applies the URL rules", () => {
    expect(
      sanitizeHtmlAttributes(
        "a",
        { href: "javascript:alert(1)", style: "color: red" },
        undefined,
        safe,
      ),
    ).toEqual({ style: "color: red" });
  });

  it("allows presentational tags only when opted in", () => {
    for (const tag of ["font", "center", "details", "summary"]) {
      expect(isAllowedHtmlTag(tag)).toBe(false);
      expect(isAllowedHtmlTag(tag, safe)).toBe(true);
    }
    for (const tag of ["style", "script", "form", "input", "svg", "object"]) {
      expect(isAllowedHtmlTag(tag, safe)).toBe(false);
    }
  });
});
