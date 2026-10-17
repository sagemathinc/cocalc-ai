// Real-browser test of HTML output (html-output.tsx) in a trusted notebook:
// faithful HTML renders inline and sanitized; styled or active HTML renders
// in an opaque frame that sizes to its content, follows the app's theme and
// table style (with the content's own CSS winning), and can't reach the app.
// Run from the frontend package:
//   CHROMIUM_PATH=/usr/bin/chromium node jupyter/output-messages/html-output.browser-test.mjs
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
    return <div id="cell" style={{ fontFamily: "monospace", fontSize: "17px" }}><CellOutputMessages output={output} trust /></div>;
  }
  const sheet = document.createElement("style");
  sheet.textContent = appearanceStyleSheet();
  document.head.append(sheet);
  createRoot(document.getElementById("root")).render(<App />);
`);

const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(app);
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><html><head><title>app</title></head><body><div id="root"></div><div id="app-secret">secret</div><script src="/app.js"></script></body></html>`,
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const html = (value) => ({
  output_type: "display_data",
  data: { "text/html": value },
});

const rows = Array.from(
  { length: 30 },
  (_, i) => `<tr><th>${i}</th><td>${i * i}</td></tr>`,
).join("");
// The shape of pandas' DataFrame._repr_html_().
const DATAFRAME = `<div><style scoped>.dataframe tbody td { color: rgb(1, 2, 3); }</style><table border="1" class="dataframe"><thead><tr><th></th><th>a</th></tr></thead><tbody>${rows}</tbody></table></div>`;
const ESCAPE = `<p id="escape">x</p><script>
  var r = {};
  try { r.parentDom = parent.document.getElementById("app-secret").textContent; } catch (e) { r.parentDom = "blocked"; }
  try { parent.document.title = "pwned"; r.title = "changed"; } catch (e) { r.title = "blocked"; }
  try { r.cookie = document.cookie; } catch (e) { r.cookie = "blocked"; }
  r.origin = self.origin;
  document.getElementById("escape").textContent = JSON.stringify(r);
</script>`;

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

  await page.evaluate((o) => window.__setOutput(o), {
    0: html('<b id="inline" class="ant-btn" style="color:red">inline</b>x'),
    1: html('<b id="plain" class="ant-btn">plain</b>'),
    2: html(DATAFRAME),
    3: html(ESCAPE),
  });

  // 1. Faithful HTML is inline and sanitized (class and id dropped), even in
  // a trusted notebook.
  const plain = page.locator("#cell b", { hasText: "plain" });
  await plain.waitFor();
  assert.deepEqual(
    await plain.evaluate((b) => b.getAttributeNames()),
    [],
    "inline output is sanitized",
  );
  assert.equal(
    await page.locator("#cell b", { hasText: "inline" }).count(),
    0,
    "styled output is not inline",
  );

  // 2. Styled and active output are framed, opaque.
  const frames = page.locator("#cell iframe");
  await page.waitForFunction(
    () => document.querySelectorAll("#cell iframe").length === 3,
  );
  for (let i = 0; i < 3; i++) {
    assert.equal(
      await frames.nth(i).getAttribute("sandbox"),
      "allow-forms allow-scripts allow-presentation",
    );
  }
  const frame = async (i) => {
    const f = await (await frames.nth(i).elementHandle()).contentFrame();
    await f.waitForFunction(() => document.readyState === "complete");
    return f;
  };
  const styled = await frame(0);
  assert.equal(
    await styled.evaluate(
      () => getComputedStyle(document.getElementById("inline")).color,
    ),
    "rgb(255, 0, 0)",
    "the frame keeps the output's style",
  );

  // 3. The frame sizes to its content (beyond the 320px default), and ends
  // at its final height.
  const table = await frame(1);
  const fits = async () => {
    const content = await table.evaluate(
      () => document.documentElement.scrollHeight,
    );
    const height = await frames
      .nth(1)
      .evaluate((e) => e.getBoundingClientRect().height);
    return {
      content,
      height,
      ok: content > 400 && Math.abs(height - content) <= 16,
    };
  };
  let size = await fits();
  for (let i = 0; i < 50 && !size.ok; i++) {
    await page.waitForTimeout(100);
    size = await fits();
  }
  assert.ok(
    size.ok,
    `frame height ${size.height} fits content ${size.content}`,
  );
  assert.equal(
    await frames.nth(1).evaluate((e) => e.contentDocument),
    null,
    "opaque",
  );

  // 4. The notebook's table style, with the content's own CSS winning.
  const cellStyle = await table.evaluate(() => {
    const td = document.querySelector("tbody td");
    const cs = getComputedStyle(td);
    return {
      border: cs.borderTopStyle,
      align: cs.textAlign,
      color: cs.color,
      font: getComputedStyle(document.documentElement).fontFamily,
      size: getComputedStyle(document.documentElement).fontSize,
    };
  });
  assert.deepEqual(cellStyle, {
    border: "none",
    align: "right",
    color: "rgb(1, 2, 3)",
    font: "monospace",
    size: "17px",
  });

  // 5. Theme: the frame follows the app's light/dark palette.
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (t) => document.documentElement.setAttribute("data-cocalc-theme", t),
      theme,
    );
    const expected = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "var(--cocalc-ui-text)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await table.waitForFunction(
      (e) => getComputedStyle(document.documentElement).color === e,
      expected,
      { timeout: 5000 },
    );
    assert.equal(
      await table.evaluate(() => document.documentElement.style.colorScheme),
      theme,
    );
  }

  // 6. Isolation from the app.
  const escape = await frame(2);
  await escape.waitForFunction(() =>
    document.getElementById("escape")?.textContent.startsWith("{"),
  );
  assert.deepEqual(
    JSON.parse(
      await escape.evaluate(
        () => document.getElementById("escape").textContent,
      ),
    ),
    {
      parentDom: "blocked",
      title: "blocked",
      cookie: "blocked",
      origin: "null",
    },
  );
  assert.equal(await page.title(), "app");

  assert.deepEqual(errors, []);
  console.log("html-output browser test: ok");
} finally {
  await browser?.close();
  server.close();
}
