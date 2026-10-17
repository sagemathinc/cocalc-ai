/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shared by the jsdom and Node tests of html-fidelity.ts: the classifier must
// give the same answer in the browser and in static export.

export const INLINE: [string, string][] = [
  ["plain text", "hello"],
  ["formatting", "<p><b>bold</b> and <i>italic</i><br></p>"],
  [
    "a plain table",
    "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>",
  ],
  ["Sage's <html> wrapper", "<html>\\[x^2\\]</html>"],
  ["an inline math script", '<script type="math/tex">x^2</script>'],
  ["classes and data attributes", '<div class="a" data-x="1">x</div>'],
  ["a body with only a class", '<body class="x"><p>x</p></body>'],
  [
    "an empty head",
    "<html><head> <!-- c --> </head><body><p>x</p></body></html>",
  ],
  ["a comment", "<!-- c --><b>x</b>"],
  ["a safe link", '<a href="https://example.com" target="_blank">x</a>'],
  ["a safe image", '<img src="https://example.com/a.png" alt="a">'],
  [
    "an allowed embed",
    '<iframe src="https://www.youtube.com/embed/x" allowfullscreen></iframe>',
  ],
];

export const FRAMED: [string, string][] = [
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
  ["an iframe from elsewhere", '<iframe src="https://example.com/"></iframe>'],
  ["SVG", '<svg><circle r="1"></circle></svg>'],
  ["a form", "<form><input value=1></form>"],
  ["a stylesheet link", '<link rel="stylesheet" href="x.css"><p>x</p>'],
  [
    "a full document",
    "<!doctype html><html><head><title>t</title></head><body>x</body></html>",
  ],
  [
    "inline math in the head (html-ssr drops the head)",
    '<head><script type="math/tex">x^2</script></head><body><p>body</p></body>',
  ],
  ["a styled body", '<body style="color:rgb(255,0,0)"><p>red</p></body>'],
  ["a root attribute", '<html dir="rtl"><p>x</p></html>'],
  ["direction", '<p dir="rtl">abc אבג</p>'],
  ["a tooltip", '<span title="tip">x</span>'],
  ["an anchor target", '<h2 id="sec">x</h2>'],
  ["a language", '<p lang="ja">x</p>'],
  ["translate", '<p translate="no">x</p>'],
  ["a role", '<div role="alert">x</div>'],
  ["an aria attribute", '<span aria-label="x">y</span>'],
];
