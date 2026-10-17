/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { renderToStaticMarkup } from "react-dom/server";
import HTML from "@cocalc/frontend/components/html-ssr";
import { sanitizeHtmlAttributes } from "@cocalc/frontend/components/sanitize-html";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import {
  URL_REJECTED,
  applyUrlTransform,
  applyUrlTransformToSrcset,
  parseSrcset,
} from "./url-transform";

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

describe("srcset", () => {
  const IMG = `<div><img src="https://e.example/a.png" srcset="https://e.example/b.png 1x, https://e.example/c.png 2x" alt="probe"></div>`;

  it("transforms each candidate and keeps descriptors", () => {
    expect(
      applyUrlTransformToSrcset((u) => `/files/${u}`, "a.png 1x, b.png 640w"),
    ).toBe("/files/a.png 1x, /files/b.png 640w");
    expect(
      applyUrlTransformToSrcset(
        (u) => (u.startsWith("bad") ? URL_REJECTED : undefined),
        "bad.png 1x, ok.png 2x",
      ),
    ).toBe("ok.png 2x");
    expect(applyUrlTransformToSrcset(() => URL_REJECTED, "a 1x, b 2x")).toBe(
      null,
    );
  });

  it("is dropped with src when images are rejected (central policy)", () => {
    expect(
      sanitizeHtmlAttributes(
        "img",
        {
          src: "https://e.example/a.png",
          srcset: "https://e.example/b.png 1x",
          alt: "probe",
        },
        () => URL_REJECTED,
      ),
    ).toEqual({ alt: "probe" });
  });

  it("is dropped in sanitized html-ssr", () => {
    const html = renderToStaticMarkup(
      <FileContext.Provider
        value={{
          urlTransform: (_url, tag) =>
            tag === "img" ? URL_REJECTED : undefined,
        }}
      >
        <HTML value={IMG} />
      </FileContext.Provider>,
    );
    expect(html).not.toContain("e.example");
    expect(html).toContain('alt="probe"');
  });

  it("is dropped in noSanitize html-ssr", () => {
    const html = renderToStaticMarkup(
      <FileContext.Provider
        value={{ noSanitize: true, urlTransform: () => URL_REJECTED }}
      >
        <HTML value={IMG} />
      </FileContext.Provider>,
    );
    expect(html).not.toContain("e.example");
    expect(html).toContain('alt="probe"');
  });

  it("treats a throwing transform as rejection", () => {
    expect(
      applyUrlTransform(() => {
        throw Error("boom");
      }, "x"),
    ).toBeNull();
  });
});

describe("srcset parsing", () => {
  it("keeps commas inside URLs (data: URLs)", () => {
    expect(
      parseSrcset("data:image/png,https://e.example/x 1x, b.png 2x"),
    ).toEqual([
      { url: "data:image/png,https://e.example/x", descriptors: "1x" },
      { url: "b.png", descriptors: "2x" },
    ]);
    expect(parseSrcset("a,b.png 1x")).toEqual([
      { url: "a,b.png", descriptors: "1x" },
    ]);
  });

  it("ends a URL at trailing commas and drops odd descriptors", () => {
    expect(parseSrcset("a.png,b.png 2x")).toEqual([
      { url: "a.png,b.png", descriptors: "2x" },
    ]);
    expect(parseSrcset("a.png, b.png 640w")).toEqual([
      { url: "a.png", descriptors: "" },
      { url: "b.png", descriptors: "640w" },
    ]);
    expect(parseSrcset("a.png (x,https://e.example/y) 1x")).toEqual([]);
  });

  it("a rejected data: candidate does not become a live one", () => {
    const reject = (url: string) =>
      url.startsWith("data:") ? URL_REJECTED : undefined;
    expect(
      applyUrlTransformToSrcset(
        reject,
        "data:image/png,https://e.example/x 1x",
      ),
    ).toBeNull();
    expect(
      sanitizeHtmlAttributes(
        "img",
        { srcset: "data:image/png,https://e.example/x 1x", alt: "a" },
        reject,
      ),
    ).toEqual({ alt: "a" });
  });

  it("the central policy no longer splits data: URLs into candidates", () => {
    // data: is not a safe image URL scheme here; the whole candidate goes.
    expect(
      sanitizeHtmlAttributes("img", {
        srcset: "data:image/png,https://e.example/x 1x",
        alt: "a",
      }),
    ).toEqual({ alt: "a" });
  });

  it("noSanitize rejects by tag, keeping untagged transforms otherwise", () => {
    const html = renderToStaticMarkup(
      <FileContext.Provider
        value={{
          noSanitize: true,
          urlTransform: (url, tag) =>
            tag === "img" ? URL_REJECTED : `/files/${url}`,
        }}
      >
        <HTML
          value={`<div><img src="https://e.example/a.png" srcset="https://e.example/b.png 1x" alt="probe"><video src="v.mp4"></video></div>`}
        />
      </FileContext.Provider>,
    );
    expect(html).not.toContain("e.example");
    expect(html).toContain('alt="probe"');
    expect(html).toContain('src="/files/v.mp4"');
  });
});
