/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

import $ from "jquery";

import { UNTRUSTED_IFRAME_SANDBOX } from "@cocalc/frontend/components/sanitize-html";
import { sanitize_html } from "./sanitize";

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
