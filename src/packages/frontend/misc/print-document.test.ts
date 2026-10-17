/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  PASSIVE_DOCUMENT_CSP,
  escapeHtmlText,
  passiveBody,
  writePassiveDocument,
} from "./print-document";

export function popupWindow(): Window {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  return iframe.contentWindow!;
}

const HOSTILE = `<p>ok <b>bold</b></p>
<meta http-equiv="refresh" content="0; url=/evil">
<base href="https://e.example/">
<script>parent.__xss = 1</script>
<img src="x.png" onerror="parent.__xss = 2" alt="pic">
<iframe src="https://e.example/frame"></iframe>
<iframe srcdoc="<script>parent.__xss=3</script>"></iframe>
<object data="x"></object><embed src="x">
<form action="https://e.example/"><button formaction="https://e.example/">b</button></form>
<a href="javascript:parent.__xss=4">j</a><a href="https://example.com/">link</a>
<template><meta http-equiv="refresh" content="0"></template>
<svg><style>&lt;/style&gt;&lt;meta http-equiv=refresh content=0&gt;</style><a href="javascript:x"><text>t</text></a></svg>
<link rel="prefetch" href="https://e.example/p"><link rel="stylesheet" href="s.css">`;

describe("passiveBody", () => {
  it("removes navigation, frames, script, forms and handlers", () => {
    const body = passiveBody(HOSTILE);
    for (const sel of [
      "meta",
      "base",
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "template",
      "link[rel=prefetch]",
    ]) {
      expect(body.querySelector(sel)).toBeNull();
    }
    for (const elt of Array.from(body.querySelectorAll("*"))) {
      for (const name of elt.getAttributeNames()) {
        expect(name.startsWith("on")).toBe(false);
        expect(elt.getAttribute(name)).not.toMatch(/javascript:/i);
      }
    }
    expect(body.querySelector("b")?.textContent).toBe("bold");
    expect(body.querySelector("img")?.getAttribute("alt")).toBe("pic");
    expect(
      body.querySelector("a[href='https://example.com/']")?.textContent,
    ).toBe("link");
    expect(body.querySelector("link[rel=stylesheet]")).not.toBeNull();
  });
});

describe("writePassiveDocument", () => {
  it("writes our shell with the CSP first and imports the passive body", () => {
    const w = popupWindow();
    writePassiveDocument(w, {
      title: "<img src=x onerror=1>.md",
      head: `<style>.x{color:red}</style>`,
      bodyStyle: "margin:7%",
      body: HOSTILE,
    });
    const doc = w.document;
    const first = doc.head.firstElementChild!;
    expect(first.outerHTML).toBe(PASSIVE_DOCUMENT_CSP);
    expect(doc.title).toBe("<img src=x onerror=1>.md");
    expect(doc.head.querySelector("style")?.textContent).toBe(".x{color:red}");
    expect(doc.body.getAttribute("style")).toBe("margin:7%");
    // The only meta elements are ours, in <head>.
    expect(doc.body.querySelector("meta")).toBeNull();
    expect(doc.querySelectorAll("meta[http-equiv=refresh]").length).toBe(0);
    expect(
      doc.querySelector("iframe,script,base,object,embed,form"),
    ).toBeNull();
    // The SVG style text stays text: no reparse turns it into a <meta>.
    expect(doc.querySelector("svg style")?.textContent).toContain("<meta");
    expect(doc.body.querySelector("b")?.textContent).toBe("bold");
  });

  it("blocks scripts, frames, plugins, base and forms in the CSP", () => {
    const content = /content="([^"]*)"/.exec(PASSIVE_DOCUMENT_CSP)?.[1];
    for (const directive of [
      "script-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "child-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(content).toContain(directive);
    }
  });
});

describe("escapeHtmlText", () => {
  it("escapes text", () => {
    expect(escapeHtmlText(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
