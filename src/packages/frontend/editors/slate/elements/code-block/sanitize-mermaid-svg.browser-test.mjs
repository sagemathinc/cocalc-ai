// Browser check of the mermaid SVG output policy with Chromium's real CSS
// parser (jsdom has none, so the jest tests can only check that it fails
// closed).
// Run from the frontend package:
//   node editors/slate/elements/code-block/sanitize-mermaid-svg.browser-test.mjs
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = fileURLToPath(new URL("./", import.meta.url));
const fixtures = JSON.parse(
  readFileSync(`${here}__fixtures__/mermaid-11-svgs.json`, "utf8"),
);
const bundle = await build({
  entryPoints: [`${here}sanitize-mermaid-svg.ts`],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "policy",
});
const script = bundle.outputFiles[0].text;

// Every request the page makes to this server is a policy failure, except
// the page itself.
const hits = [];
const server = createServer((req, res) => {
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    res.end(
      `<!doctype html><html><body><div id="outside">outside</div><div id="root"></div></body></html>`,
    );
    return;
  }
  if (req.url !== "/favicon.ico") hits.push(req.url);
  res.end("");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium-browser",
});
try {
  const page = await browser.newPage();

  // 1. Hostile CSS: nothing outside the diagram changes, nothing loads.
  await page.goto(origin);
  await page.addScriptTag({ content: script });
  const hostile = await page.evaluate((origin) => {
    const svg = `<svg id="d1" xmlns="http://www.w3.org/2000/svg">
      <style>
        @import url(${origin}/import.css);
        @font-face { font-family: f; src: url(${origin}/font) }
        body { display: none }
        #outside { display: none }
        #d1 ~ div, #d1 + div { display: none }
        :root { --x: 1 }
        #d1 { background-image: image-set("${origin}/image-set-sheet.png" 1x) }
        #d1 rect { fill: url(#g); stroke: rgb(1, 2, 3) }
        #d1 text::selection { color: red }
        @media all { #outside { color: rgb(9, 9, 9) } #d1 text { fill: rgb(4, 5, 6) } }
        @keyframes dash { to { stroke-dashoffset: 0 } }
      </style>
      <defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>
      <rect width="10" height="10" style='background-image: image-set("${origin}/image-set-inline.png" 1x); position: fixed' cursor='image-set("${origin}/cursor.png" 1x), auto'/>
      <text>t</text>
    </svg>`;
    const clean = policy.sanitizeMermaidSvg(svg);
    document.getElementById("root").replaceChildren(clean);
    const outside = document.getElementById("outside");
    return {
      bodyDisplay: getComputedStyle(document.body).display,
      outsideDisplay: getComputedStyle(outside).display,
      outsideColor: getComputedStyle(outside).color,
      rectStroke: getComputedStyle(clean.querySelector("rect")).stroke,
      rectFill: getComputedStyle(clean.querySelector("rect")).fill,
      rectPosition: getComputedStyle(clean.querySelector("rect")).position,
      textFill: getComputedStyle(clean.querySelector("text")).fill,
      style: clean.querySelector("style").textContent,
    };
  }, origin);
  await page.waitForTimeout(500);
  assert.equal(hostile.bodyDisplay, "block");
  assert.equal(hostile.outsideDisplay, "block");
  assert.notEqual(hostile.outsideColor, "rgb(9, 9, 9)");
  // Rules for the diagram itself still apply, including fragment urls.
  assert.equal(hostile.rectStroke, "rgb(1, 2, 3)");
  assert.match(hostile.rectFill, /url\(.*#g/);
  assert.notEqual(hostile.rectPosition, "fixed");
  assert.equal(hostile.textFill, "rgb(4, 5, 6)");
  assert.match(hostile.style, /@keyframes dash/);
  assert.doesNotMatch(hostile.style, /image-set|@import|@font-face/);
  // Every selector is scoped to the diagram's root.
  for (const selector of hostile.style.match(/[^{}]+(?=\{)/g)) {
    const s = selector.trim();
    if (/^@(media|keyframes)|^\d+%$|^(from|to)$/.test(s)) continue;
    for (const part of s.split(/,(?![^(]*\))/)) {
      assert.match(part.trim(), /^:is\(#d1, #d1 \*\):is\(/, part);
    }
  }
  assert.deepEqual(hits, []);

  // 2. Real mermaid output: the sanitized diagram computes the same styles as
  // the raw one, and loads nothing.
  for (const [name, svg] of Object.entries(fixtures)) {
    const styles = {};
    for (const mode of ["raw", "clean"]) {
      await page.goto(origin);
      await page.addScriptTag({ content: script });
      styles[mode] = await page.evaluate(
        ({ svg, mode }) => {
          const root = document.getElementById("root");
          if (mode === "raw") {
            // Parse the raw SVG the way innerHTML would, without a sink.
            const parsed = new DOMParser().parseFromString(
              `<body>${svg}`,
              "text/html",
            ).body.firstElementChild;
            root.replaceChildren(document.importNode(parsed, true));
          } else {
            root.replaceChildren(policy.sanitizeMermaidSvg(svg));
          }
          const props = [
            "fill",
            "stroke",
            "font-family",
            "font-size",
            "opacity",
          ];
          return Array.from(
            root.querySelectorAll("svg text, svg rect, svg path, svg circle"),
          ).map((elt) => {
            const cs = getComputedStyle(elt);
            return props.map((p) => cs.getPropertyValue(p)).join("|");
          });
        },
        { svg, mode },
      );
    }
    assert.ok(styles.raw.length > 0, `${name}: no elements`);
    assert.equal(styles.clean.length, styles.raw.length, `${name}: elements`);
    // Hostile fixtures differ on purpose (their external CSS is removed).
    if (!name.startsWith("evil_") && name !== "directive") {
      assert.deepEqual(styles.clean, styles.raw, `${name}: computed styles`);
    }
  }
  await page.waitForTimeout(500);
  // The raw hostile fixtures load from evil.example, not this server, so any
  // hit here comes from the sanitized output.
  assert.deepEqual(hits, []);
  console.log("sanitize-mermaid-svg browser test: ok");
} finally {
  await browser.close();
  server.close();
}
