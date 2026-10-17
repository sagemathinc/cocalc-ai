/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

import $ from "jquery";

import { UNTRUSTED_IFRAME_SANDBOX } from "@cocalc/frontend/components/sanitize-html";
import { sanitize_html, sanitize_html_allowlist } from "./sanitize";

describe("legacy HTML safety floor", () => {
  beforeAll(() => {
    globalThis.jQuery = $;
  });

  it("sandboxes untrusted iframes when unsafe attributes are preserved", () => {
    const html = sanitize_html(
      '<iframe srcdoc="<script>parent.__XSS = true</script>" sandbox="allow-scripts allow-same-origin"></iframe>',
      true,
      true,
    );
    const root = document.createElement("div");
    root.innerHTML = html;

    expect(root.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      UNTRUSTED_IFRAME_SANDBOX,
    );
    expect(html).not.toContain("allow-same-origin");
  });

  it("drops active embedded-content tags when unsafe attributes are preserved", () => {
    const html = sanitize_html(
      '<object data="payload"></object><embed src="payload"><applet></applet>',
      true,
      true,
    );

    expect(html).not.toContain("<object");
    expect(html).not.toContain("<embed");
    expect(html).not.toContain("<applet");
  });

  it("does not sandbox a vetted video embed", () => {
    const html = sanitize_html(
      '<iframe src="https://www.youtube.com/embed/example"></iframe>',
      true,
      true,
    );
    const root = document.createElement("div");
    root.innerHTML = html;

    expect(root.querySelector("iframe")?.hasAttribute("sandbox")).toBe(false);
  });
});

describe("sanitize_html_allowlist", () => {
  beforeAll(() => {
    globalThis.jQuery = $;
  });

  const render = (html: string) => {
    const root = document.createElement("div");
    root.innerHTML = sanitize_html_allowlist(html);
    return root;
  };

  it("keeps ordinary Markdown output", () => {
    const root = render(
      '<h1>Title</h1><p>Some <em>text</em> and <a href="https://example.com">a link</a></p><pre><code>x = 1</code></pre><ul><li>item</li></ul><img src="pic.png" alt="pic">',
    );
    expect(root.querySelector("h1")?.textContent).toBe("Title");
    expect(root.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com",
    );
    expect(root.querySelector("code")?.textContent).toBe("x = 1");
    expect(root.querySelector("img")?.getAttribute("src")).toBe("pic.png");
  });

  it("keeps math as TeX text and task-list checkboxes", () => {
    const root = render(
      '<p>Inline <script type="math/tex">x^2</script></p><script type="math/tex; mode=display">\\int f</script><ul><li><input type="checkbox" checked="true"> task</li></ul>',
    );
    expect(root.textContent).toContain("$x^2$");
    expect(root.textContent).toContain("$$\\int f$$");
    expect(root.querySelector("script")).toBeNull();
    const box = root.querySelector("input");
    expect(box?.getAttribute("type")).toBe("checkbox");
    expect(box?.hasAttribute("disabled")).toBe(true);
  });

  it("removes active content", () => {
    const root = render(
      [
        '<img src="x" onerror="window.__xss=1">',
        "<script>window.__xss=2</script>",
        "<style>body{display:none}</style>",
        '<form action="https://evil.example"><input name="q"></form>',
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        '<a href="javascript:window.__xss=3">click</a>',
        '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>t</text></a></svg>',
      ].join(""),
    );
    const html = root.innerHTML;
    expect(html).not.toMatch(/onerror|<script|<style|<form|<meta|javascript:/i);
    expect(root.textContent).not.toContain("window.__xss=2");
    expect(root.textContent).not.toContain("display:none");
    expect(root.textContent).toContain("click");
  });
});
