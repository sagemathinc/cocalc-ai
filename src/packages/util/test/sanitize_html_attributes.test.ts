/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { sanitize_html_attributes } from "../misc";

describe("sanitize_html_attributes", () => {
  // Mock jQuery: $(node) returns an object with removeAttr
  const $ = (node: { attributes?: { name: string; value: string }[] }) => ({
    removeAttr: (name: string) => {
      if (node.attributes) {
        const idx = node.attributes.findIndex((a) => a.name === name);
        if (idx !== -1) {
          node.attributes.splice(idx, 1);
        }
      }
    },
  });

  test("removes standard onload attribute", () => {
    const node = {
      attributes: [
        { name: "onload", value: "alert(1)" },
        { name: "class", value: "test" },
      ],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(1);
    expect(node.attributes[0].name).toBe("class");
  });

  test("removes ONLOAD attribute (case insensitivity)", () => {
    const node = {
      attributes: [
        { name: "ONLOAD", value: "alert(1)" },
        { name: "class", value: "test" },
      ],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(1);
    expect(node.attributes[0].name).toBe("class");
  });

  test("removes javascript: href", () => {
    const node = {
      attributes: [{ name: "href", value: "javascript:alert(1)" }],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(0);
  });

  test("removes JaVaScRiPt: href (case insensitivity)", () => {
    const node = {
      attributes: [{ name: "href", value: "JaVaScRiPt:alert(1)" }],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(0);
  });

  test("removes javascript: with whitespace", () => {
    const node = {
      attributes: [{ name: "href", value: " javascript:alert(1)" }],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(0);
  });

  test("removes javascript: with control characters", () => {
    const node = {
      attributes: [{ name: "href", value: "java\tscript:alert(1)" }],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(0);
  });

  test("removes vbscript: href", () => {
    const node = {
      attributes: [{ name: "href", value: "vbscript:msgbox(1)" }],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(0);
  });

  test("keeps safe href values", () => {
    const node = {
      attributes: [{ name: "href", value: "https://example.com" }],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(1);
    expect(node.attributes[0].name).toBe("href");
  });

  test("removes all consecutive unsafe attributes (live-collection regression)", () => {
    // This is the XSS scenario: consecutive on* attributes where removing
    // the first one would shift indices and skip the second in a live
    // NamedNodeMap if iterated without snapshotting.
    const node = {
      attributes: [
        { name: "onload", value: "alert(1)" },
        { name: "onerror", value: "alert(2)" },
        { name: "class", value: "test" },
      ],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(1);
    expect(node.attributes[0].name).toBe("class");
  });

  test("removes many unsafe attributes interleaved with safe ones", () => {
    const node = {
      attributes: [
        { name: "onload", value: "x" },
        { name: "class", value: "ok" },
        { name: "onerror", value: "x" },
        { name: "id", value: "ok" },
        { name: "onclick", value: "x" },
      ],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(2);
    expect(node.attributes.map((a) => a.name)).toEqual(["class", "id"]);
  });

  test("removes javascript: from SVG animate values (url sink, not an href)", () => {
    // <svg><a><animate attributeName="href" values="javascript:..."/></a></svg>
    // assigns the anchor's href at runtime, so `values` is a url sink even
    // though it is not one of the obvious url-valued attributes. This is why
    // the protocol test must run over every attribute; an allowlist misses it.
    const node = {
      attributes: [
        { name: "attributeName", value: "href" },
        { name: "values", value: "javascript:alert(42)" },
        { name: "dur", value: "1s" },
      ],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes.map((a) => a.name)).toEqual([
      "attributeName",
      "dur",
    ]);
  });

  test("removes a dangerous animation value hidden behind a safe first one", () => {
    // `values` is a ";"-separated list, so the payload need not be at the
    // start: the animation assigns each value to href in turn. Testing only
    // the beginning of the attribute misses this.
    const node = {
      attributes: [
        { name: "attributeName", value: "href" },
        { name: "values", value: "https://example.com;javascript:alert(99)" },
        { name: "calcMode", value: "discrete" },
      ],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes.map((a) => a.name)).toEqual([
      "attributeName",
      "calcMode",
    ]);
  });

  test("segments every attribute, and tolerates padding inside a segment", () => {
    const node = {
      attributes: [
        { name: "to", value: "  https://ok.example ; \tvb\tscript:msgbox(1)" },
        { name: "href", value: "https://a.example;https://b.example" },
      ],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes.map((a) => a.name)).toEqual(["href"]);
  });

  test("KNOWN false positive: prose in a non-URL attribute is dropped", () => {
    // Documents current behaviour rather than endorsing it. Because the check
    // runs over every attribute and ignores whitespace, ordinary text that
    // happens to read "JavaScript:" is treated as a pseudo-protocol and the
    // attribute is deleted. Narrowing this needs a real sanitizer policy (an
    // allowlist of url attributes is NOT safe -- see the animate test above),
    // so it is tracked in .agents/cocalc-port-backlog.md rather than patched.
    const node = {
      attributes: [{ name: "title", value: "JavaScript: The Good Parts" }],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(0);
  });

  test("removes javascript: however far the ignored characters push it", () => {
    // A browser strips leading controls/spaces and removes tab/CR/LF from
    // anywhere in a URL, so this is live; the check must not stop after a
    // fixed-size prefix.
    const padded = " ".repeat(500) + "j\ta\tv\ta\ts\tc\tr\ti\tp\tt:alert(1)";
    const node = { attributes: [{ name: "href", value: padded }] };
    sanitize_html_attributes($, node);
    expect(node.attributes).toHaveLength(0);
  });

  test("checks attributes other than href", () => {
    const node = {
      attributes: [
        { name: "src", value: "javascript:alert(1)" },
        { name: "formaction", value: "JAVASCRIPT:alert(2)" },
        { name: "xlink:href", value: " vbscript:msgbox(3)" },
        { name: "cite", value: "https://example.com" },
      ],
    };
    sanitize_html_attributes($, node);
    expect(node.attributes.map((a) => a.name)).toEqual(["cite"]);
  });

  test("does not throw on a node without attributes", () => {
    expect(() => sanitize_html_attributes($, {})).not.toThrow();
  });
});
