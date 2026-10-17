// Trust fidelity harness: renders a corpus of real notebook outputs through
// the production output and Markdown components, as a trusted and as an
// untrusted notebook, in Chromium, and records what renders and where it runs
// (the app page, or a frame and the sandbox of every frame boundary).
//
// It is the measurement tool for removing notebook trust: each step must keep
// a case's result, while running "in page" must go away.
//
// Fidelity notes (what is and is not the production path):
// - Kernel output goes through the project's own preprocessing
//   (@cocalc/jupyter/util/blobify-output: images, PDFs and isolated HTML into
//   the blob store) and is rendered by the real CellOutput, with blobs served
//   through BlobStoreContext as in read-only notebook views.
// - Markdown cells render with MostlyStaticMarkdown, as cell-input.tsx does,
//   under the notebook's FileContext (noSanitize: trust, as cell-list.tsx,
//   plus getMermaid as in projects).  Not measured: attachments, headings'
//   anchor component, and the live editor chrome.
// - Widgets need a live kernel and are listed as unmeasured.
//
// Each case renders alone in a fresh page (all outputs of its cell together),
// waits for its own readiness with a deadline, and keeps its own console,
// page and request errors.  A frame that can't be inspected is reported as
// "unknown", never as "not working".
//
// Build the corpus first (jupyter/__fixtures__/trust-corpus/make-corpus.py),
// then run from the frontend package:
//   CHROMIUM_PATH=/usr/bin/chromium node jupyter/trust-fidelity.browser-test.mjs \
//     [corpus.ipynb (default /tmp/trust-corpus.ipynb)] [out-dir] [--repeat N]
// The corpus outputs load libraries from public CDNs, so this needs network.
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const repeatIndex = args.indexOf("--repeat");
const repeat = repeatIndex >= 0 ? Number(args.splice(repeatIndex, 2)[1]) : 1;
const corpusPath = args[0] ?? "/tmp/trust-corpus.ipynb";
const outDir = args[1] ?? "/tmp/trust-fidelity";
const DEADLINE_MS = Number(process.env.CASE_DEADLINE_MS ?? 20000);
mkdirSync(outDir, { recursive: true });

const frontend = fileURLToPath(new URL("../", import.meta.url));
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
      import { createRoot } from "react-dom/client";
      import { fromJS } from "immutable";
      import { IPynbImporter } from "@cocalc/jupyter/ipynb/import-from-ipynb";
      import { blobifyOutputData } from "@cocalc/jupyter/util/blobify-output";
      import { CellOutput } from "./jupyter/cell-output";
      import { JupyterContext } from "./jupyter/jupyter-context";
      import { FileContext } from "./lib/file-context";
      import MostlyStaticMarkdown from "./editors/slate/mostly-static-markdown";
      import getMermaid from "./editors/slate/elements/code-block/get-mermaid";
      import { BlobStoreContext } from "./jupyter/output-messages/use-blob";
      import "./jupyter/output-messages/mime-types/init-frontend";

      const params = new URLSearchParams(location.search);
      const trust = params.get("trust") === "1";
      const only = params.get("case");
      // Load the notebook the way the live notebook does
      // (JupyterActions.setToIpynb): IPynbImporter, with every output going
      // through the project's output preprocessing (processOutput ->
      // blobifyOutputData), and an in-memory blob store.
      const blobs = new Map();
      const ipynb = JSON.parse(window.__CORPUS);
      const importer = new IPynbImporter();
      let nextId = 0;
      importer.import({
        ipynb,
        new_id: () => "cell" + nextId++,
        // As JupyterActions.cellOutputHandler: process, then store.
        cellOutputHandler: (cell) => ({
          message: (content, k) => {
            if (content?.data != null) {
              blobifyOutputData(content.data, (bytes, sha1) => {
                blobs.set(sha1, new Uint8Array(bytes));
                return sha1;
              });
            }
            cell.output[k] = content;
          },
        }),
      });
      const cells = importer.cells();
      const cellList = Object.keys(cells).sort((a, b) => cells[a].pos - cells[b].pos);
      const kernelspec = { name: importer.kernel(), display_name: importer.kernel(), language: "python" };
      const blobStore = { asyncBlobStore: { get: async (key) => blobs.get(key) } };

      function caseName(input) {
        return /case: ([\\w-]+)/.exec(input ?? "")?.[1] ?? "?";
      }

      function App() {
        const ids = cellList.filter((id) => only == null || caseName(cells[id].input) === only);
        return (
          <BlobStoreContext.Provider value={blobStore}>
            <JupyterContext.Provider value={{ kernelspec, trust }}>
              <FileContext.Provider
                value={{ noSanitize: trust, disableMarkdownCodebar: true, getMermaid }}
              >
                {ids.map((id) => {
                  const cell = cells[id];
                  return (
                    <section key={id} data-case={caseName(cell.input)}>
                      {cell.cell_type === "markdown" ? (
                        <div className="cocalc-jupyter-rendered cocalc-jupyter-rendered-md">
                          <MostlyStaticMarkdown value={(cell.input ?? "").trim()} />
                        </div>
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

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="root"></div>
<script>window.__CORPUS = ${JSON.stringify(corpus).replace(/</g, "\\u003c")};</script>
<script src="/app.js"></script></body></html>`;
const server = createServer((request, response) => {
  if (request.url === "/app.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(bundle.outputFiles[0].text);
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(pageHtml);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// What "it works" means for each case: an expression over q(sel) (first
// match, searching open shadow roots too), qa(sel) and text, evaluated in the
// case's page and in every frame under it.  A short string means it works.
const WORKS = {
  "markdown-inline-style": `qa("*").some(e => e.textContent === "inline style" && getComputedStyle(e).color === "rgb(0, 128, 0)") ? "styled" : ""`,
  "markdown-math": `q(".katex") ? "katex" : ""`,
  "markdown-katex-href": `q(".katex a[href]") ? "link" : ""`,
  "markdown-mermaid": `qa("svg text, svg foreignObject").some(e => e.textContent.includes("mermaid start")) ? "diagram" : ""`,
  "javascript-sibling": `q("#js-sibling-target")?.textContent === "changed by sibling js" ? "ran" : ""`,
  pdf: `qa("embed, iframe, object").some(e => (e.getAttribute("type") ?? "").includes("pdf") || /^(blob:|data:application\\/pdf)/.test(e.getAttribute("src") ?? e.getAttribute("data") ?? "")) ? "pdf" : ""`,
  "matplotlib-png": `qa("img").some(i => /^(blob:|data:image\\/png)/.test(i.src) && i.naturalWidth > 100) ? "img" : ""`,
  "matplotlib-svg": `qa("img").some(i => /^(blob:|data:image\\/svg)/.test(i.src) && i.naturalWidth > 100) ? "svg" : ""`,
  "pandas-table": `qa("table td").some(td => td.textContent === "x") ? "table" : ""`,
  "pandas-styler": `qa("td").some(td => getComputedStyle(td).backgroundColor === "rgb(255, 255, 0)") ? "styled" : ""`,
  "html-inline-style": `qa("*").some(e => e.textContent === "styled span" && getComputedStyle(e).color === "rgb(200, 0, 0)") ? "styled" : ""`,
  "html-script": `q("#html-script-target")?.textContent === "script ran" ? "ran" : ""`,
  "display-javascript": `qa("*").some(e => e.children.length === 0 && e.textContent === "javascript output ran") ? "ran" : ""`,
  "plotly-cdn": `q(".main-svg") ? "plot" : ""`,
  "plotly-init-notebook-mode": `q(".main-svg") ? "plot" : ""`,
  bokeh: `qa("canvas").some(c => c.width > 50 && c.height > 50) ? "plot" : ""`,
  altair: `q(".vega-embed svg, .vega-embed canvas, canvas.marks, svg.marks") ? "chart" : ""`,
  folium: `q(".leaflet-container .leaflet-tile-pane, .leaflet-container") ? "map" : ""`,
};

// Widgets need a live kernel (comm messages); unmeasured here.
const NEEDS_KERNEL = [
  "ipywidgets-slider",
  "ipywidgets-html",
  "ipympl",
  "ipyleaflet",
  "bqplot",
];

// Evaluates a check against root (an element or a document), searching open
// shadow roots too.  Serialized into the page and frames.
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
  return (
    new Function("q", "qa", "text", `return ${check};`)(
      q,
      qa,
      deepText(base),
    ) || ""
  );
}

// The sandbox at each frame boundary from the page down to frame.
async function frameChain(frame) {
  const chain = [];
  for (let f = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const el = await f.frameElement().catch(() => null);
    chain.unshift(
      el
        ? await el
            .evaluate((e) => ({
              sandbox: e.getAttribute("sandbox"),
              title: e.getAttribute("title") ?? "",
              width: Math.round(e.getBoundingClientRect().width),
              height: Math.round(e.getBoundingClientRect().height),
            }))
            .catch(() => ({ unknown: true }))
        : { unknown: true },
    );
  }
  return chain;
}

async function measureCase(browser, name, trust) {
  if (process.env.VERBOSE) console.error(`case ${name} trust=${trust}`);
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) =>
    errors.push(`pageerror: ${e.message.slice(0, 200)}`),
  );
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("requestfailed", (r) =>
    errors.push(
      `request: ${r.url().slice(0, 120)} ${r.failure()?.errorText ?? ""}`,
    ),
  );
  const result = { works: "", where: "", frames: [], errors, unknownFrames: 0 };
  try {
    await page.goto(`${origin}/?trust=${trust ? 1 : 0}&case=${name}`);
    await page.waitForSelector("section[data-case]", { timeout: DEADLINE_MS });
    const check = WORKS[name];
    const started = Date.now();
    while (Date.now() - started < DEADLINE_MS) {
      result.unknownFrames = 0;
      const inPage = await page
        .locator("section[data-case]")
        .evaluate(
          (el, [fn, c]) => new Function(`return (${fn})`)()(el, c),
          [runCheck.toString(), check],
        )
        .catch((e) => {
          errors.push(`check: ${e.message.slice(0, 160)}`);
          return "";
        });
      if (inPage) {
        result.works = inPage;
        result.where = "page";
        break;
      }
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        let r;
        try {
          r = await frame.evaluate(
            ([fn, c]) => new Function(`return (${fn})`)()(document, c),
            [runCheck.toString(), check],
          );
        } catch {
          result.unknownFrames += 1;
          continue;
        }
        if (r) {
          result.works = r;
          result.where = "frame";
          result.frames = await frameChain(frame);
          break;
        }
      }
      if (result.works) break;
      await page.waitForTimeout(250);
    }
    if (!result.frames.length) {
      // Inventory every frame boundary under the case even when nothing works.
      for (const frame of page.frames()) {
        if (frame !== page.mainFrame())
          result.frames.push(await frameChain(frame));
      }
    }
    const section = page.locator("section[data-case]");
    await section.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await section
      .screenshot({
        path: `${outDir}/${trust ? "trusted" : "untrusted"}-${name}.png`,
      })
      .catch((e) => errors.push(`screenshot: ${e.message.slice(0, 120)}`));
  } catch (e) {
    errors.push(`harness: ${e.message.slice(0, 200)}`);
    result.where = "error";
  } finally {
    await page.close();
  }
  return result;
}

function fmt(r) {
  if (r.where === "error") return "error";
  if (r.works) return `${r.where}:${r.works}`;
  return r.unknownFrames ? "unknown" : "-";
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium-browser",
    args: ["--no-sandbox"],
  });
  const runs = [];
  for (let run = 0; run < repeat; run++) {
    const report = { trusted: {}, untrusted: {} };
    for (const trust of [true, false]) {
      for (const name of Object.keys(WORKS)) {
        if (process.env.ONLY_CASE && process.env.ONLY_CASE !== name) continue;
        report[trust ? "trusted" : "untrusted"][name] = await measureCase(
          browser,
          name,
          trust,
        );
        if (process.env.VERBOSE) {
          console.error(
            JSON.stringify(report[trust ? "trusted" : "untrusted"][name]).slice(
              0,
              600,
            ),
          );
        }
      }
    }
    runs.push(report);
  }
  const report = runs[0];
  writeFileSync(
    `${outDir}/report.json`,
    JSON.stringify(repeat > 1 ? runs : report, null, 2),
  );
  console.log("case".padEnd(28), "trusted".padEnd(24), "untrusted");
  for (const name of Object.keys(WORKS)) {
    if (process.env.ONLY_CASE && process.env.ONLY_CASE !== name) continue;
    const t = runs.map((r) => fmt(r.trusted[name]));
    const u = runs.map((r) => fmt(r.untrusted[name]));
    const flaky = new Set(t).size > 1 || new Set(u).size > 1;
    console.log(
      name.padEnd(28),
      t[0].padEnd(24),
      u[0].padEnd(16),
      flaky ? `FLAKY trusted=${t.join("/")} untrusted=${u.join("/")}` : "",
    );
  }
  for (const name of NEEDS_KERNEL) {
    console.log(name.padEnd(28), "unmeasured (needs a live kernel)");
  }
  console.log(`\nscreenshots and report.json in ${outDir}`);
} finally {
  await browser?.close();
  server.close();
}
