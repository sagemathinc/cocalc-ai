// Real-browser check that a link to a section of a public docs page (such as
// the homepage's starter tasks) lands with its heading below the sticky
// public header, at desktop and phone widths, whether the browser follows the
// fragment or the page scrolls the section into view.
// Run from the frontend package:
//   CHROMIUM_PATH=/usr/bin/chromium node public/docs/anchor-offset.browser-test.mjs
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { bundleFrontend } from "../../test/browser-bundle.mjs";

const SLUG = "ai/my-agents";
const SECTIONS = [
  "turn-a-recurring-task-into-an-app",
  "investigate-a-change-in-your-data",
];

const app = await bundleFrontend(`
  import { createRoot } from "react-dom/client";
  import PublicDocsApp from "./public/docs/app";
  createRoot(document.getElementById("root")).render(
    <PublicDocsApp
      config={{ cocalc_product: "launchpad", is_launchpad: true, site_name: "CoCalc" }}
      initialRoute={{ view: "docs-detail", slug: "${SLUG}" }}
    />,
  );
`);

const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    res.end(app);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.on("pageerror", (e) => console.error("pageerror:", e.message));
    await page.goto(`http://127.0.0.1:${port}/docs/${SLUG}`);
    await page.waitForSelector(`#${SECTIONS[0]}`);
    for (const id of SECTIONS) {
      for (const how of ["fragment", "scrollIntoView"]) {
        await page.evaluate(
          ({ id, how }) => {
            window.scrollTo(0, 0);
            if (how === "fragment") {
              location.hash = "";
              location.hash = id;
            } else {
              document
                .getElementById(id)
                .scrollIntoView({ block: "start", behavior: "instant" });
            }
          },
          { id, how },
        );
        await page.waitForTimeout(100);
        const { headingTop, headerBottom, scrolled } = await page.evaluate(
          (id) => {
            const header = document.querySelector(".ant-layout-header");
            return {
              headingTop: document.getElementById(id).getBoundingClientRect()
                .top,
              headerBottom: header?.getBoundingClientRect().bottom ?? 0,
              scrolled: window.scrollY,
            };
          },
          id,
        );
        assert.ok(scrolled > 0, `${width}px ${how} #${id}: page scrolled`);
        assert.ok(
          headerBottom > 0,
          `${width}px ${how} #${id}: sticky header present`,
        );
        assert.ok(
          headingTop >= headerBottom,
          `${width}px ${how} #${id}: heading top ${headingTop} is under the header (bottom ${headerBottom})`,
        );
      }
    }
    await page.close();
  }
  console.log("ok: docs section headings land below the public header");
} finally {
  await browser.close();
  server.close();
}
