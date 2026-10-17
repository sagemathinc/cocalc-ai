/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

import { sanitizedHtmlIsFaithful } from "./html-fidelity";

describe("sanitizedHtmlIsFaithful", () => {
  it.each([
    ["plain text", "hello"],
    ["formatting", "<p><b>bold</b> and <i>italic</i><br></p>"],
    [
      "a plain table",
      "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>",
    ],
    ["Sage's <html> wrapper", "<html>\\[x^2\\]</html>"],
    ["an inline math script", '<script type="math/tex">x^2</script>'],
    [
      "cosmetic attributes",
      '<div class="a" id="b" data-x="1" aria-label="c">x</div>',
    ],
    ["a safe link", '<a href="https://example.com" target="_blank">x</a>'],
    ["a safe image", '<img src="https://example.com/a.png" alt="a">'],
    [
      "an allowed embed",
      '<iframe src="https://www.youtube.com/embed/x" allowfullscreen></iframe>',
    ],
  ])("inline: %s", (_, html) => {
    expect(sanitizedHtmlIsFaithful(html)).toBe(true);
  });

  it.each([
    [
      "a <style> block (pandas)",
      "<style scoped>td{color:red}</style><table></table>",
    ],
    ["a style attribute (Styler)", '<span style="color:red">x</span>'],
    ["a script", "<div id=x></div><script>x.textContent=1</script>"],
    ["an event handler", '<b onclick="f()">x</b>'],
    ["a tag outside the allowlist", '<font color="red">x</font>'],
    ["a table span", "<table><tr><td colspan=2>x</td></tr></table>"],
    ["a table attribute", '<table border="1"><tr><td>x</td></tr></table>'],
    ["an unsafe URL", '<a href="javascript:alert(1)">x</a>'],
    ["an iframe with srcdoc (folium)", '<iframe srcdoc="&lt;p&gt;x"></iframe>'],
    [
      "an iframe from elsewhere",
      '<iframe src="https://example.com/"></iframe>',
    ],
    ["SVG", '<svg><circle r="1"></circle></svg>'],
    ["a form", "<form><input value=1></form>"],
    ["a stylesheet link", '<link rel="stylesheet" href="x.css"><p>x</p>'],
    [
      "a full document",
      "<!doctype html><html><head><title>t</title></head><body>x</body></html>",
    ],
  ])("framed: %s", (_, html) => {
    expect(sanitizedHtmlIsFaithful(html)).toBe(false);
  });
});
