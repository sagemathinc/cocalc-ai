// Real-browser test of trusted JavaScript output (active-output-group.tsx):
// live streaming without replay, ordering, syntax errors, and isolation of
// the opaque frame from this page.
// Run from the frontend package:
//   CHROMIUM_PATH=/usr/bin/chromium node jupyter/output-messages/active-output-group.browser-test.mjs
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { bundleFrontend } from "../../test/browser-bundle.mjs";

const app = await bundleFrontend(`
  import { useState } from "react";
  import { createRoot } from "react-dom/client";
  import { fromJS } from "immutable";
  import { CellOutputMessages } from "./jupyter/output-messages/message";
  import { appearanceStyleSheet } from "@cocalc/util/appearance-palette";
  import "./jupyter/output-messages/mime-types/init-frontend";
  function App() {
    const [output, setOutput] = useState(fromJS({}));
    window.__setOutput = (o) => setOutput(fromJS(o));
    return <div id="cell"><CellOutputMessages output={output} trust /></div>;
  }
  const sheet = document.createElement("style");
  sheet.textContent = appearanceStyleSheet();
  document.head.append(sheet);
  document.cookie = "app_session=secret";
  localStorage.setItem("app_marker", "secret");
  createRoot(document.getElementById("root")).render(<App />);
`);

const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(app);
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><html><body><div id="root"></div><div id="app-secret">secret</div><script src="/app.js"></script></body></html>`,
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const html = (value) => ({
  output_type: "display_data",
  data: { "text/html": value },
});
const js = (code) => ({
  output_type: "display_data",
  data: { "application/javascript": code },
});
const COUNT = `window.__runs = (window.__runs || 0) + 1; element.text("runs " + window.__runs);`;

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium-browser",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page
    .waitForFunction(() => typeof window.__setOutput === "function", null, {
      timeout: 15000,
    })
    .catch((e) => {
      throw Error(`app did not start: ${errors.join(" | ") || e.message}`);
    });

  const set = async (output) => {
    await page.evaluate((o) => window.__setOutput(o), output);
    await page.waitForTimeout(300);
  };
  const frame = async () => {
    const handle = await page.waitForSelector(
      '#cell iframe[title="Jupyter JavaScript output"]',
    );
    const f = await handle.contentFrame();
    await f.waitForFunction(() => document.readyState === "complete");
    return f;
  };

  // 1. Streaming: appending outputs never re-runs earlier JavaScript.
  await set({ 0: html("<div id='target'>target</div>") });
  assert.equal(
    await page
      .locator('#cell iframe[title="Jupyter JavaScript output"]')
      .count(),
    0,
    "no JavaScript frame before JS",
  );
  await set({ 0: html("<div id='target'>target</div>"), 1: js(COUNT) });
  let f = await frame();
  await f.waitForFunction(() => window.__runs === 1);
  await set({
    0: html("<div id='target'>target</div>"),
    1: js(COUNT),
    2: html("<p>later</p>"),
  });
  await set({
    0: html("<div id='target'>target</div>"),
    1: js(COUNT),
    2: html("<p>later</p>"),
    3: { name: "stdout", text: "printed" },
  });
  f = await frame();
  assert.equal(await f.evaluate(() => window.__runs), 1, "no replay on append");
  assert.equal(
    await f.evaluate(() => document.querySelectorAll(".output_html").length),
    2,
  );
  assert.match(await page.locator("#cell").innerText(), /printed/);

  // update_display_data: a changed output runs once more; the old one is gone.
  await set({
    0: html("<div id='target'>target</div>"),
    1: js(COUNT + " /* v2 */"),
    2: html("<p>later</p>"),
  });
  await f.waitForFunction(() => window.__runs === 2);
  await page.waitForTimeout(300);
  assert.equal(
    await f.evaluate(() => window.__runs),
    2,
    "changed output runs once",
  );
  assert.equal(
    await f.evaluate(
      () => document.querySelectorAll(".output_javascript").length,
    ),
    1,
  );
  assert.equal(
    await f.evaluate(() =>
      [...document.querySelectorAll("#cocalc-outputs > div")]
        .map((d) => d.className)
        .join(","),
    ),
    "output_html,output_javascript,output_html",
    "order kept",
  );

  // Exact identity.  These two scripts collided (19xve70.s) under the 32-bit
  // digest used before; replacing one with the other must run the second.
  await set({});
  await set({ 0: js('element.text("5opiHUtIFGpE")') });
  f = await frame();
  await f.waitForFunction(
    () =>
      document.querySelector(".output_javascript")?.textContent ===
      "5opiHUtIFGpE",
  );
  await set({ 0: js('element.text("149ArEHM7oZ6")') });
  await f.waitForFunction(
    () =>
      document.querySelector(".output_javascript")?.textContent ===
      "149ArEHM7oZ6",
  );
  // The same value as HTML, then as JavaScript: the kind change must run it.
  const both = 'document.title = "kind-changed"';
  await set({ 0: html(both), 1: js("1") });
  await f.waitForFunction(() => document.querySelector(".output_html") != null);
  assert.notEqual(await f.evaluate(() => document.title), "kind-changed");
  await set({ 0: js(both), 1: js("1") });
  await f.waitForFunction(() => document.title === "kind-changed");
  // stdout -> stderr with the same text changes its presentation.
  await set({
    0: html("<b>a</b>"),
    1: { name: "stdout", text: "same" },
    2: js("1"),
  });
  await f.waitForFunction(
    () => document.querySelector("pre.output_stdout")?.textContent === "same",
  );
  await set({
    0: html("<b>a</b>"),
    1: { name: "stderr", text: "same" },
    2: js("1"),
  });
  await f.waitForFunction(
    () => document.querySelector("pre.output_stderr")?.textContent === "same",
  );

  // Text between frame outputs stays in order inside the frame.
  await set({});
  await set({
    0: html("<div>first</div>"),
    1: { name: "stdout", text: "printed between" },
    2: { name: "stderr", text: "warned between" },
    3: js("element.text('script')"),
    4: { name: "stdout", text: "printed after" },
  });
  f = await frame();
  await f.waitForFunction(
    () =>
      document.querySelector(".output_javascript")?.textContent === "script",
  );
  assert.equal(
    await f.evaluate(() =>
      [...document.querySelectorAll("#cocalc-outputs > *")]
        .map((d) => d.className)
        .join(","),
    ),
    "output_html,output_stdout,output_stderr,output_javascript",
  );
  assert.match(await page.locator("#cell").innerText(), /printed after/);

  // Theme: the frame follows the app's explicit light/dark palette, without
  // reloading or re-running scripts.
  await set({});
  await set({
    0: js(COUNT),
    1: { name: "stderr", text: "warned" },
    2: html("<b>t</b>"),
  });
  f = await frame();
  await f.waitForFunction(() => window.__runs >= 1);
  const runsBefore = await f.evaluate(() => window.__runs);
  for (const theme of ["dark", "light", "dark"]) {
    await page.evaluate(
      (t) => document.documentElement.setAttribute("data-cocalc-theme", t),
      theme,
    );
    const expected = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "var(--cocalc-ui-text)";
      probe.style.background = "var(--cocalc-ui-surface)";
      probe.style.borderColor = "var(--cocalc-ui-dangerBg)";
      document.body.append(probe);
      const cs = getComputedStyle(probe);
      const r = {
        text: cs.color,
        surface: cs.backgroundColor,
        danger: cs.borderTopColor,
      };
      probe.remove();
      return r;
    });
    await f.waitForFunction(
      (e) => getComputedStyle(document.body).color === e.text,
      expected,
      { timeout: 5000 },
    );
    const actual = await f.evaluate(() => ({
      text: getComputedStyle(document.body).color,
      surface: getComputedStyle(document.body).backgroundColor,
      danger: getComputedStyle(document.querySelector("pre.output_stderr"))
        .backgroundColor,
      scheme: document.documentElement.style.colorScheme,
    }));
    assert.deepEqual(
      { text: actual.text, surface: actual.surface, danger: actual.danger },
      expected,
      `frame palette follows ${theme}`,
    );
    assert.equal(actual.scheme, theme);
  }
  assert.equal(
    await f.evaluate(() => window.__runs),
    runsBefore,
    "theme change re-ran no script",
  );
  if (process.env.SHOW_THEME) console.log("dark/light palette checked");

  // 2. JavaScript can target an output that comes after it.
  await set({});
  await set({
    0: js(`document.getElementById("later").textContent = "found";`),
    1: html("<div id='later'>not yet</div>"),
  });
  f = await frame();
  await f.waitForFunction(
    () => document.getElementById("later")?.textContent === "found",
  );

  // 3. Syntax errors are caught and shown.
  await set({});
  await set({ 0: js("this is ( not javascript") });
  f = await frame();
  await f.waitForSelector(".cocalc-javascript-error");

  // 4. Isolation from this page.
  await set({});
  await set({
    0: js(`
      const r = {};
      try { r.parentDom = parent.document.getElementById("app-secret").textContent; } catch (e) { r.parentDom = "blocked"; }
      try { r.cookie = document.cookie; } catch (e) { r.cookie = "blocked"; }
      try { r.storage = localStorage.getItem("app_marker"); } catch (e) { r.storage = "blocked"; }
      try { top.location.href = "about:blank#hijacked"; r.top = "navigated"; } catch (e) { r.top = "blocked"; }
      try { r.popup = window.open("about:blank") ? "opened" : "blocked"; } catch (e) { r.popup = "blocked"; }
      r.origin = self.origin;
      // A forged update from inside the frame must be ignored.
      window.postMessage({ type: "cocalc-active-outputs", outputs: [{ index: 0, kind: "html", value: "<b id=forged>forged</b>" }] }, "*");
      element.text(JSON.stringify(r));
    `),
  });
  f = await frame();
  await f.waitForFunction(() =>
    document.querySelector(".output_javascript")?.textContent.startsWith("{"),
  );
  await page.waitForTimeout(300);
  const r = JSON.parse(
    await f.evaluate(
      () => document.querySelector(".output_javascript").textContent,
    ),
  );
  assert.deepEqual(r, {
    parentDom: "blocked",
    cookie: "blocked",
    storage: "blocked",
    top: "blocked",
    popup: "blocked",
    origin: "null",
  });
  assert.equal(
    await f.evaluate(() => document.getElementById("forged")),
    null,
    "forged update ignored",
  );
  // (The app's own router may change the path; the frame's attempt must not land.)
  assert.ok(
    !page.url().includes("hijacked"),
    "app page not navigated by the frame",
  );

  // 5. Resize requests are capped (the bridge's id is readable by content).
  await set({});
  await set({
    0: js(`
      const id = /var id = "([^"]+)"/.exec([...document.scripts].map((s) => s.textContent).join("\\n"))[1];
      for (let i = 0; i < 50; i++) parent.postMessage({ type: "cocalc-jupyter-iframe-height", id, height: 1e9 }, "*");
    `),
  });
  await page.waitForTimeout(800);
  const height = await page
    .locator("#cell iframe")
    .evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(height <= 25000, `frame height capped (${height})`);

  assert.deepEqual(errors, []);
  console.log("active-output-group browser test: ok");
} finally {
  await browser?.close();
  server.close();
}
