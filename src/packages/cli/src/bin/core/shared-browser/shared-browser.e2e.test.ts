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
import { SharedBrowserPage } from "./agent-page";
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

const FORM =
  "data:text/html,<title>form</title><input id=q><button id=go onclick=\"document.title='clicked '+q.value\">Go</button>" +
  "<form onsubmit=\"document.title='submitted';return false\"><input id=s></form><p>Hello text</p>";

test(
  "the built-in agent actions drive the page and wait while the human drives",
  {
    skip: executable ? false : "no Chrome/Chromium installed",
    timeout: 120_000,
  },
  async () => {
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
    const { cdpPort } = await server.start();
    const page = await SharedBrowserPage.open(`http://127.0.0.1:${cdpPort}`);
    try {
      assert.equal((await page.goto(FORM)).title, "form");
      await page.type("a(b)'c", "#q");
      assert.equal((await page.click("#go")).title, "clicked a(b)'c");
      await page.type("x", "#s");
      assert.equal((await page.press("Enter")).title, "submitted");
      assert.equal(await page.evaluate("Promise.resolve(6 * 7)"), 42);
      await assert.rejects(page.evaluate("nope()"), /nope is not defined/);
      assert.match((await page.text()).text, /Hello text/);
      const png = await page.screenshot();
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      await assert.rejects(page.click("#missing"), /no element matches/);

      server.setDriver("human");
      let done = false;
      const held = page.evaluate("1").then(() => (done = true));
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(done, false, "an agent action waits while the human drives");
      server.setDriver("agent");
      await held;
      assert.equal(done, true);
    } finally {
      page.close();
      await server.close();
      await browser.stop();
      await profile.cleanup();
    }
  },
);

test(
  "a persistent profile relaunches (the old DevTools port file is ignored)",
  {
    skip: executable ? false : "no Chrome/Chromium installed",
    timeout: 120_000,
  },
  async () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const profileDir = mkdtempSync(join(tmpdir(), "cocalc-browser-persist-"));
    try {
      for (let run = 0; run < 2; run++) {
        const browser = await launchBrowser({
          executable: executable!,
          profileDir,
          args: sharedBrowserChromeArgs(profileDir),
        });
        try {
          const version = await (
            await fetch(`http://127.0.0.1:${browser.port}/json/version`)
          ).json();
          assert.match(version.Browser, /Chrome/);
        } finally {
          // Like a project stop: the port file stays behind.
          await browser.stop();
        }
      }
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  },
);

test(
  "a file's browser is the human's first; waiting agents and ignored input are shown",
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
      humanFirst: true,
      handBackAfterMs: 300,
    });
    const { port, cdpPort } = await server.start();
    const human = await chromium.launch({
      executablePath: executable,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    try {
      const viewer = await human.newPage();
      await viewer.goto(`http://127.0.0.1:${port}/`);
      await viewer.waitForFunction(() =>
        document
          .querySelector("#driver .msg")
          ?.textContent?.startsWith("You are driving"),
      );
      assert.equal(server.getState().driver, "human");

      // An agent action waits, and the human is told.
      const page = await SharedBrowserPage.open(`http://127.0.0.1:${cdpPort}`);
      const held = page.evaluate("1 + 1");
      await viewer.waitForFunction(() =>
        document
          .querySelector("#driver .msg")
          ?.textContent?.includes("waiting"),
      );
      await viewer.click("#driver button"); // hand back
      assert.equal(await held, 2);

      // Clicking while the agent drives explains why nothing happens.
      await viewer.click("#screen");
      await viewer.waitForSelector("#notdriving", { state: "visible" });
      await viewer.click("#notdriving button");
      await viewer.waitForFunction(() =>
        document
          .querySelector("#driver .msg")
          ?.textContent?.startsWith("You are driving"),
      );

      // Closing the last viewer hands back, so agents never wait on nobody.
      await viewer.close();
      const deadline = Date.now() + 5000;
      while (server.getState().driver !== "agent" && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      assert.equal(server.getState().driver, "agent");
      page.close();
    } finally {
      await human.close().catch(() => {});
      await server.close();
      await browser.stop();
      await profile.cleanup();
    }
  },
);

test(
  "two viewers (split frames) show their own tabs of one browser",
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
      humanFirst: true,
    });
    const { port, cdpPort } = await server.start();
    const human = await chromium.launch({
      executablePath: executable,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    const urlOf = (viewer: any) =>
      viewer.evaluate(() => (document.getElementById("url") as any).value);
    const frames = (viewer: any) =>
      viewer.evaluate(() => (window as any).__frames ?? 0);
    try {
      const open = async (view: string) => {
        const viewer = await human.newPage({
          viewport: { width: 700, height: 500 },
        });
        // Count frames drawn into this viewer's canvas.
        await viewer.addInitScript(() => {
          const draw = CanvasRenderingContext2D.prototype.drawImage;
          CanvasRenderingContext2D.prototype.drawImage = function (
            ...args: any[]
          ) {
            (window as any).__frames = ((window as any).__frames ?? 0) + 1;
            return (draw as any).apply(this, args);
          };
        });
        await viewer.goto(`http://127.0.0.1:${port}/?view=${view}`);
        await viewer.waitForFunction(
          () => document.getElementById("status")?.textContent === "live",
        );
        return viewer;
      };
      const a = await open("frame-a");
      await a.fill("#url", "data:text/html,<title>one</title>A");
      await a.press("#url", "Enter");
      await a.waitForFunction(() =>
        document.querySelector(".tab.active")?.textContent?.includes("one"),
      );
      let b = await open("frame-b"); // the split: starts on the same tab
      assert.match(await urlOf(b), /title>one/);

      await b.click("#newtab");
      await b.waitForFunction(
        () => document.querySelectorAll(".tab").length === 2,
      );
      await b.fill("#url", "data:text/html,<title>two</title>B");
      await b.press("#url", "Enter");
      await b.waitForFunction(() =>
        document.querySelector(".tab.active")?.textContent?.includes("two"),
      );
      // A still shows its own tab, and both keep streaming.
      await a.waitForFunction(
        () => document.querySelectorAll(".tab").length === 2,
      );
      assert.match(await urlOf(a), /title>one/);
      assert.ok((await frames(a)) > 0, "A was streamed its tab");
      assert.ok((await frames(b)) > 0, "B was streamed its tab");

      // A frame that reloads comes back to its own tab.
      await b.close();
      b = await open("frame-b");
      await b.waitForFunction(() =>
        document.querySelector(".tab.active")?.textContent?.includes("two"),
      );
      assert.match(await urlOf(a), /title>one/);

      // Agents act where the human last worked: B's tab.
      await b.click("#driver button"); // hand back
      const page = await SharedBrowserPage.open(
        `http://127.0.0.1:${cdpPort}`,
        server.getState().active,
      );
      assert.equal((await page.location()).title, "two");
      page.close();
    } finally {
      await human.close().catch(() => {});
      await server.close();
      await browser.stop();
      await profile.cleanup();
    }
  },
);
