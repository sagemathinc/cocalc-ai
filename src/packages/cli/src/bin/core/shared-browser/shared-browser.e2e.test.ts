// End to end: a real Chromium behind the shared browser server, an agent
// over CDP (Playwright) and a "human" using the viewer page in a second
// browser.  Skipped when no Chrome/Chromium is installed.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createProfileDir,
  defaultLocalBrowserSystem,
  findChrome,
  launchBrowser,
} from "../local-browser";
import { SharedBrowserServer } from "./server";
import { sharedBrowserChromeArgs } from "./service";

const sys = defaultLocalBrowserSystem();
let executable: string | undefined;
try {
  executable = findChrome(undefined, sys);
} catch {
  executable = undefined;
}

const PAGE =
  "data:text/html,<title>t</title><input id=t autofocus style='width:600px'>";

test(
  "the human types any character and pastes once; the agent sees it after hand-back",
  {
    skip: executable ? false : "no Chrome/Chromium installed",
    timeout: 120_000,
  },
  async () => {
    const { chromium } = require("playwright-core");
    const profile = await createProfileDir("disk", sys);
    const browser = await launchBrowser({
      executable: executable!,
      profileDir: profile.path,
      args: sharedBrowserChromeArgs(profile.path),
    });
    const version = await (
      await fetch(`http://127.0.0.1:${browser.port}/json/version`)
    ).json();
    const server = new SharedBrowserServer({
      chromeWebSocketUrl: version.webSocketDebuggerUrl,
      host: "127.0.0.1",
      port: 0,
      cdpPort: 0,
    });
    const { port, cdpPort } = await server.start();
    const agent = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const human = await chromium.launch({
      executablePath: executable,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    try {
      const page = agent.contexts()[0].pages()[0];
      await page.goto(PAGE);

      const viewer = await human.newPage({
        viewport: { width: 900, height: 600 },
      });
      await viewer.goto(`http://127.0.0.1:${port}/`);
      await viewer.waitForFunction(
        () => document.getElementById("status")?.textContent === "live",
      );
      await viewer.click("#driver button"); // take over
      await viewer.waitForFunction(() =>
        document
          .querySelector("#driver button")
          ?.textContent?.startsWith("Hand back"),
      );

      // Click into the input (top-left of the page) and type characters whose
      // char codes collide with navigation key codes, e.g. "(" = ArrowDown.
      const canvas = await viewer.locator("#screen").boundingBox();
      await viewer.mouse.click(canvas!.x + 40, canvas!.y + 18);
      const typed = `f(x) = 'a' . 100% & "b"`;
      await viewer.keyboard.type(typed);
      // One paste, delivered the way a real paste arrives (on the canvas).
      await viewer.evaluate(() => {
        const data = new DataTransfer();
        data.setData("text", "[pasted]");
        document
          .getElementById("screen")!
          .dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
          );
      });
      await new Promise((r) => setTimeout(r, 500));
      await viewer.click("#driver button"); // hand back

      const value = await page.$eval("#t", (el: HTMLInputElement) => el.value);
      assert.equal(value, `${typed}[pasted]`);
    } finally {
      await agent.close().catch(() => {});
      await human.close().catch(() => {});
      await server.close();
      await browser.stop();
      await profile.cleanup();
    }
  },
);
