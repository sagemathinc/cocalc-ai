/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { renderToStaticMarkup } from "react-dom/server";
import HTML from "@cocalc/frontend/components/html-ssr";
import { sanitizeHtmlAttributes } from "@cocalc/frontend/components/sanitize-html";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { URL_REJECTED, applyUrlTransform } from "./url-transform";

describe("applyUrlTransform", () => {
  it("keeps, replaces or rejects", () => {
    expect(applyUrlTransform(undefined, "a.png")).toBe("a.png");
    expect(applyUrlTransform(() => undefined, "a.png")).toBe("a.png");
    expect(applyUrlTransform(() => "b.png", "a.png")).toBe("b.png");
    expect(applyUrlTransform(() => URL_REJECTED, "a.png")).toBeNull();
  });

  it("passes the tag", () => {
    const seen: (string | undefined)[] = [];
    applyUrlTransform((_, tag) => void seen.push(tag), "x", "img");
    expect(seen).toEqual(["img"]);
  });
});

describe("rejection drops the attribute", () => {
  const reject = (_url: string, tag?: string) =>
    tag === "img" ? URL_REJECTED : undefined;

  it("in the central attribute policy", () => {
    expect(
      sanitizeHtmlAttributes(
        "img",
        { src: "https://e.example/a.png", alt: "a" },
        reject,
      ),
    ).toEqual({ alt: "a" });
    expect(
      sanitizeHtmlAttributes("a", { href: "https://example.com" }, reject),
    ).toEqual({ href: "https://example.com" });
  });

  it("in sanitized html-ssr", () => {
    const html = renderToStaticMarkup(
      <FileContext.Provider value={{ urlTransform: reject }}>
        <HTML value={`<img src="https://e.example/a.png" alt="a">`} />
      </FileContext.Provider>,
    );
    expect(html).not.toContain("e.example");
    expect(html).toContain('alt="a"');
  });

  it("in noSanitize html-ssr", () => {
    const html = renderToStaticMarkup(
      <FileContext.Provider
        value={{ noSanitize: true, urlTransform: () => URL_REJECTED }}
      >
        <HTML value={`<img src="https://e.example/a.png" alt="a">`} />
      </FileContext.Provider>,
    );
    expect(html).not.toContain("e.example");
    expect(html).toContain('alt="a"');
  });
});
