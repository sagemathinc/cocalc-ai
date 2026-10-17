// Trust fidelity harness: renders a corpus of real notebook outputs through
// the real CellOutput / Markdown components, as a trusted and as an untrusted
// notebook, in Chromium, and records what actually renders and where scripts
// run (the app page, or an isolated frame).
//
// It is a measurement tool for removing notebook trust: every step must keep
// the "works" column for each case, while "runs in page" must become false.
//
// Build the corpus first (see jupyter/__fixtures__/trust-corpus/make-corpus.py),
// then run from the frontend package:
//   CHROMIUM_PATH=/usr/bin/chromium node jupyter/trust-fidelity.browser-test.mjs \
//     [corpus.ipynb (default /tmp/trust-corpus.ipynb)] [out-dir]
// The corpus outputs load libraries from public CDNs, so this needs network.
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const corpusPath = process.argv[2] ?? "/tmp/trust-corpus.ipynb";
const outDir = process.argv[3] ?? "/tmp/trust-fidelity";
mkdirSync(outDir, { recursive: true });
const corpus = readFileSync(corpusPath, "utf8");

// The same browser polyfills and globals the app's rspack config provides.
const staticRequire = createRequire(
  fileURLToPath(new URL("../../static/package.json", import.meta.url)),
);
const polyfill = (name) => staticRequire.resolve(name);
const frontendRequire = createRequire(`${frontend}package.json`);
const injectFile = `${outDir}/inject.js`;
writeFileSync(
  injectFile,
  `import * as React from "${frontendRequire.resolve("react")}"; export { React }; export { Buffer } from "${polyfill("buffer/")}";`,
);

const bundle = await build({
  stdin: {
    resolveDir: frontend,
    loader: "tsx",
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { fromJS } from "immutable";
      import parse from "@cocalc/jupyter/ipynb/parse";
      import { CellOutput } from "./jupyter/cell-output";
      import { JupyterContext } from "./jupyter/jupyter-context";
      import { FileContext } from "./lib/file-context";
      import StaticMarkdown from "./editors/slate/static-markdown";
      import getMermaid from "./editors/slate/elements/code-block/get-mermaid";
      import { BlobStoreContext } from "./jupyter/output-messages/use-blob";
      import { shouldUseIframe } from "@cocalc/jupyter/util/iframe";
      import "./jupyter/output-messages/mime-types/init-frontend";

      const trust = new URLSearchParams(location.search).get("trust") === "1";
      const { cells, cellList, kernelspec } = parse(window.__CORPUS);

      // What the project does to kernel output before browsers see it
      // (jupyter/redux/actions.ts processOutput): HTML that needs isolation is
      // moved to the blob store and becomes an "iframe" output.
      const blobs = new Map();
      for (const id of cellList) {
        for (const message of Object.values(cells[id].output ?? {})) {
          const data = message?.data;
          let html = data?.["text/html"];
          if (Array.isArray(html)) html = html.join("");
          if (typeof html === "string" && shouldUseIframe(html)) {
            const key = "blob-" + blobs.size;
            blobs.set(key, new TextEncoder().encode(html));
            data.iframe = key;
            delete data["text/html"];
          }
        }
      }
      const blobStore = { asyncBlobStore: { get: async (key) => blobs.get(key) } };

      function caseName(input) {
        const m = /case: ([\\w-]+)/.exec(input ?? "");
        return m?.[1] ?? "?";
      }

      function App() {
        return (
          <BlobStoreContext.Provider value={blobStore}>
          <JupyterContext.Provider value={{ kernelspec, trust }}>
            <FileContext.Provider value={{ noSanitize: trust, getMermaid }}>
              {cellList.map((id) => {
                const cell = cells[id];
                const name = caseName(cell.input);
                return (
                  <section key={id} data-case={name} style={{ margin: 8, padding: 8, border: "1px solid #ccc" }}>
                    <h4>{name}</h4>
                    {cell.cell_type === "markdown" ? (
                      <StaticMarkdown value={cell.input} />
                    ) : (
                      <CellOutput id={id} cell={fromJS(cell)} trust={trust} />
                    )}
                  </section>
                );
              })}
            </FileContext.Provider>
          </JupyterContext.Provider>
          </BlobStoreContext.Provider>
        );
      }
      createRoot(document.getElementById("root")).render(<App />);
    `,
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  platform: "browser",
  inject: [injectFile],
  alias: {
    path: polyfill("path-browserify"),
    util: polyfill("util/"),
    assert: polyfill("assert/"),
    buffer: polyfill("buffer/"),
    stream: polyfill("stream-browserify"),
    events: staticRequire.resolve("events/", {
      paths: [
        fileURLToPath(
          new URL(
            "../../node_modules/.pnpm/events@3.3.0/node_modules",
            import.meta.url,
          ),
        ),
      ],
    }),
  },
  loader: {
    ".css": "empty",
    ".svg": "dataurl",
    ".png": "dataurl",
    ".woff": "empty",
    ".woff2": "empty",
    ".ttf": "empty",
  },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env": "{}",
    global: "window",
    DEBUG: "false",
  },
  logLevel: "error",
  plugins: [
    {
      // Node-only modules some shared code imports behind runtime checks.
      name: "node-stubs",
      setup(b) {
        b.onResolve(
          { filter: /^(fs|child_process|net|tls|os|crypto|worker_threads)$/ },
          ({ path }) => ({ path, namespace: "node-stub" }),
        );
        b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
          contents: "module.exports = {};",
          loader: "js",
        }));
      },
    },
    {
      // Generated translation catalogs may not be built in a checkout; the
      // harness renders English only.
      name: "i18n-catalogs",
      setup(b) {
        b.onResolve(
          { filter: /\/i18n\/trans\/.*\.compiled\.json$/ },
          ({ path }) => ({
            path,
            namespace: "i18n-stub",
          }),
        );
        b.onLoad({ filter: /.*/, namespace: "i18n-stub" }, () => ({
          contents: "{}",
          loader: "json",
        }));
      },
    },
  ],
});

const page_html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="root"></div>
<script>window.__CORPUS = ${JSON.stringify(corpus).replace(/</g, "\\u003c")};</script>
<script src="/app.js"></script></body></html>`;
const server = createServer((request, response) => {
  if (request.url === "/app.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(bundle.outputFiles[0].text);
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(page_html);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// What "it works" means for each case: an expression over helpers q(sel)
// (first match, searching open shadow roots too), qa(sel) and text, run
// against the case's section in the page and against every frame under it.
// It yields a short string when the output works, else "".
const WORKS = {
  "markdown-inline-style": `qa("*").some(e => e.textContent === "inline style" && getComputedStyle(e).color === "rgb(0, 128, 0)") ? "styled" : ""`,
  "markdown-math": `q(".katex") ? "katex" : ""`,
  "markdown-katex-href": `q(".katex a[href]") ? "link" : (q(".katex") ? "katex" : "")`,
  "markdown-mermaid": `qa("svg text, svg foreignObject").some(e => e.textContent.includes("mermaid start")) ? "diagram" : ""`,
  "javascript-sibling": `q("#js-sibling-target")?.textContent === "changed by sibling js" ? "ran" : ""`,
  pdf: `q("embed[type='application/pdf'], iframe[src^='blob:'], object") ? "pdf" : ""`,
  "matplotlib-png": `q("img[src^='data:image/png'], img[src^='blob:']") ? "img" : ""`,
  "matplotlib-svg": `q("svg path, img[src^='data:image/svg'], img[src^='blob:']") ? "svg" : ""`,
  "pandas-table": `q("table td") ? "table" : ""`,
  "pandas-styler": `qa("td").some(td => getComputedStyle(td).backgroundColor === "rgb(255, 255, 0)") ? "styled" : ""`,
  "html-inline-style": `qa("*").some(e => e.textContent === "styled span" && getComputedStyle(e).color === "rgb(200, 0, 0)") ? "styled" : ""`,
  "html-script": `q("#html-script-target")?.textContent === "script ran" ? "ran" : ""`,
  "display-javascript": `qa("*").some(e => e.children.length === 0 && e.textContent === "javascript output ran") ? "ran" : ""`,
  "plotly-cdn": `q(".main-svg") ? "plot" : ""`,
  "plotly-init-notebook-mode": `q(".main-svg") ? "plot" : ""`,
  bokeh: `q("canvas") ? "plot" : ""`,
  altair: `q(".vega-embed svg, .vega-embed canvas, canvas.marks, svg.marks") ? "chart" : ""`,
  folium: `q(".leaflet-container") ? "map" : ""`,
};

// Widgets need a live kernel (comm messages); this static harness can't
// render them and reports them separately.
const NEEDS_KERNEL = [
  "ipywidgets-slider",
  "ipywidgets-html",
  "ipympl",
  "ipyleaflet",
  "bqplot",
];

// Runs a check against root (an element or a document), searching open
// shadow roots too.  Serialized into the page/frames.
function runCheck(root, check) {
  const all = (node, sel, out) => {
    for (const el of node.querySelectorAll(sel)) out.push(el);
    for (const el of node.querySelectorAll("*")) {
      if (el.shadowRoot) all(el.shadowRoot, sel, out);
    }
    return out;
  };
  const deepText = (node) => {
    let t = node.textContent ?? "";
    for (const el of node.querySelectorAll("*")) {
      if (el.shadowRoot) t += deepText(el.shadowRoot);
    }
    return t;
  };
  const base = root.body ?? root;
  const qa = (sel) => all(base, sel, []);
  const q = (sel) => qa(sel)[0];
  const text = deepText(base);
  try {
    return (
      new Function("q", "qa", "text", `return ${check};`)(q, qa, text) || ""
    );
  } catch {
    return "";
  }
}

async function measure(page, trust) {
  await page.goto(`${origin}/?trust=${trust ? 1 : 0}`);
  await page.waitForSelector("section[data-case]");
  // Let CDN libraries load and render.
  await page.waitForTimeout(8000);
  const results = {};
  for (const name of [...Object.keys(WORKS), ...NEEDS_KERNEL]) {
    const section = page.locator(`section[data-case="${name}"]`);
    if ((await section.count()) === 0) {
      results[name] = { missing: true };
      continue;
    }
    const check = WORKS[name] ?? `""`;
    // In the app page: evaluate the check scoped to the section.
    const inPage = await section.evaluate(
      (el, [fn, check]) => new Function(`return (${fn})`)()(el, check),
      [runCheck.toString(), check],
    );
    // In frames under the section (any depth).
    const frameInfo = await section.evaluate((el) =>
      [...el.querySelectorAll("iframe")].map((f) => {
        const r = f.getBoundingClientRect();
        return {
          sandbox: f.getAttribute("sandbox"),
          name: f.getAttribute("title") ?? "",
          // A frame that renders but has no visible area is not "working".
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      }),
    );
    let inFrame = "";
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const owner = await frame.frameElement().catch(() => null);
      if (owner == null) continue;
      const within = await section
        .evaluate((el, f) => el.contains(f), owner)
        .catch(() => false);
      if (!within) {
        // nested frames: check the top-level owner chain
        let top = frame;
        while (top.parentFrame() && top.parentFrame() !== page.mainFrame()) {
          top = top.parentFrame();
        }
        const topOwner = await top.frameElement().catch(() => null);
        const nested =
          topOwner &&
          (await section
            .evaluate((el, f) => el.contains(f), topOwner)
            .catch(() => false));
        if (!nested) continue;
      }
      const r = await frame
        .evaluate(
          ([fn, check]) => new Function(`return (${fn})`)()(document, check),
          [runCheck.toString(), check],
        )
        .catch(() => "");
      if (r) inFrame = r;
    }
    // Frames off screen may not have painted yet.
    await section.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    await section
      .screenshot({
        path: `${outDir}/${trust ? "trusted" : "untrusted"}-${name}.png`,
      })
      .catch(() => {});
    results[name] = { inPage, inFrame, frames: frameInfo };
  }
  return results;
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium-browser",
    args: ["--no-sandbox"],
  });
  const report = {};
  for (const trust of [true, false]) {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message.slice(0, 200));
      if (process.env.VERBOSE)
        console.error("pageerror:", e.message.slice(0, 300));
    });
    report[trust ? "trusted" : "untrusted"] = await measure(page, trust);
    report[`${trust ? "trusted" : "untrusted"}-errors`] = errors;
    await page.close();
  }
  writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
  const fmt = (r) =>
    r?.missing
      ? "missing"
      : `${r.inPage ? `page:${r.inPage}` : ""}${r.inFrame ? `${r.inPage ? " " : ""}frame:${r.inFrame}` : ""}` ||
        "-";
  console.log("case".padEnd(28), "trusted".padEnd(26), "untrusted");
  for (const name of [...Object.keys(WORKS), ...NEEDS_KERNEL]) {
    console.log(
      name.padEnd(28),
      fmt(report.trusted[name]).padEnd(26),
      fmt(report.untrusted[name]),
      NEEDS_KERNEL.includes(name) ? "(needs a live kernel)" : "",
    );
  }
  console.log(`\nscreenshots and report.json in ${outDir}`);
} finally {
  await browser?.close();
  server.close();
}
