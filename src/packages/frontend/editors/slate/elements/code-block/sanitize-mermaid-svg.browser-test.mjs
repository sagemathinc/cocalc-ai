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
  assert.doesNotMatch(hostile.style, /image-set|@import|@font-face/);
  // Every selector is scoped to the diagram's root.
  for (const selector of hostile.style.match(/[^{}]+(?=\{)/g)) {
    const s = selector.trim();
    if (/^@(media|keyframes)|^\d+%$|^(from|to)$/.test(s)) continue;
    for (const part of s.split(/,(?![^(]*\))/)) {
      assert.match(
        part.trim(),
        /^:is\(\[data-cocalc-svg-scope="[0-9a-f]+"\], \[data-cocalc-svg-scope="[0-9a-f]+"\] \*\):is\(/,
        part,
      );
    }
  }
  assert.doesNotMatch(hostile.style, /@keyframes dash\b/);
  assert.match(hostile.style, /@keyframes cocalc-svg-[0-9a-f]+-dash/);
  assert.deepEqual(hits, []);

  // 1b. Links with control characters, escaped presentation attributes,
  // global keyframes, and a duplicate id outside the diagram.
  await page.goto(origin);
  await page.addScriptTag({ content: script });
  const more = await page.evaluate(async (origin) => {
    window.__fired = 0;
    const style = document.createElement("style");
    style.textContent =
      "@keyframes victim { from { opacity: .7 } to { opacity: .7 } } #anim { animation: victim 100s infinite }";
    document.head.append(style);
    const anim = document.createElement("div");
    anim.id = "anim";
    anim.textContent = "anim";
    const twin = document.createElement("div");
    twin.id = "d2";
    twin.innerText = "twin";
    document.body.append(anim, twin);
    const svg = `<svg id="d2" xmlns="http://www.w3.org/2000/svg">
      <style>
        @keyframes victim { from { opacity: .1 } to { opacity: .1 } }
        #d2 { opacity: .5 }
        #d2 rect { animation: victim 1s infinite }
      </style>
      <a href="java&#10;script:window.__fired=1"><text id="lf">lf</text></a>
      <a href="java&#9;script:window.__fired=2"><text id="tab">tab</text></a>
      <a href="java&#13;script:window.__fired=3"><text id="cr">cr</text></a>
      <rect width="10" height="10" fill="u\\72l(${origin}/fill)" cursor="u\\72l(${origin}/cursor), auto" stroke="IMAGE-SET(&quot;${origin}/set&quot; 1x)"/>
    </svg>`;
    const clean = policy.sanitizeMermaidSvg(svg);
    document.getElementById("root").replaceChildren(clean);
    for (const id of ["lf", "tab", "cr"]) {
      clean
        .querySelector(`#${id}`)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 200));
    return {
      fired: window.__fired,
      hrefs: Array.from(clean.querySelectorAll("a")).map((a) =>
        a.getAttribute("href"),
      ),
      animOpacity: getComputedStyle(anim).opacity,
      twinOpacity: getComputedStyle(twin).opacity,
      rectAnimation: getComputedStyle(clean.querySelector("rect"))
        .animationName,
    };
  }, origin);
  await page.waitForTimeout(500);
  assert.equal(more.fired, 0);
  assert.deepEqual(more.hrefs, [null, null, null]);
  assert.equal(more.animOpacity, "0.7");
  assert.equal(more.twinOpacity, "1");
  assert.match(more.rectAnimation, /^cocalc-svg-[0-9a-f]+-victim$/);
  assert.deepEqual(hits, []);

  // 1c. CSS variables can't smuggle values past the declaration checks.
  await page.goto(origin);
  await page.addScriptTag({ content: script });
  const vars = await page.evaluate(async (origin) => {
    const page = document.createElement("style");
    page.textContent = `:root { --asset: url(${origin}/probe-var) }
      @keyframes victim { from { opacity: .7 } to { opacity: .7 } }`;
    document.head.append(page);
    const svg = `<svg id="d3" xmlns="http://www.w3.org/2000/svg">
      <style>
        #d3 { --pos: fixed; position: var(--pos); --name: victim }
        #d3 rect { animation: 100s var(--name); fill: var(--asset) }
        #d3 circle { --x: 1; stroke: red }
      </style>
      <rect width="10" height="10"/>
      <circle r="5" style="--pos: fixed; position: var(--pos); fill: var(--asset); stroke: blue"/>
    </svg>`;
    const clean = policy.sanitizeMermaidSvg(svg);
    document.getElementById("root").replaceChildren(clean);
    await new Promise((r) => setTimeout(r, 200));
    const rect = clean.querySelector("rect");
    const circle = clean.querySelector("circle");
    return {
      rootPosition: getComputedStyle(clean).position,
      circlePosition: getComputedStyle(circle).position,
      rectAnimation: getComputedStyle(rect).animationName,
      circleStroke: getComputedStyle(circle).stroke,
      css: clean.querySelector("style").textContent,
      inline: circle.getAttribute("style"),
    };
  }, origin);
  await page.waitForTimeout(500);
  assert.notEqual(vars.rootPosition, "fixed");
  assert.notEqual(vars.circlePosition, "fixed");
  assert.equal(vars.rectAnimation, "none");
  assert.equal(vars.circleStroke, "rgb(0, 0, 255)");
  assert.doesNotMatch(vars.css + vars.inline, /var\(|--/);
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
