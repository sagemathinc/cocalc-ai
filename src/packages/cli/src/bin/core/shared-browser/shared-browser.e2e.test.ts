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
      const open = async (view: string, client = "me") => {
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
        await viewer.goto(
          `http://127.0.0.1:${port}/?view=${view}&client=${client}`,
        );
        await viewer.waitForFunction(
          () => document.getElementById("status")?.textContent === "live",
        );
        return viewer;
      };
      const tabCount = (n: number) => (viewer: any) =>
        viewer.waitForFunction(
          (n: number) => document.querySelectorAll(".tab").length === n,
          n,
        );
      const activeTitle = (viewer: any, title: string) =>
        viewer.waitForFunction(
          (title: string) =>
            document.querySelector(".tab.active")?.textContent?.includes(title),
          title,
        );

      const a = await open("frame:a");
      await a.fill("#url", "data:text/html,<title>one</title>A");
      await a.press("#url", "Enter");
      await activeTitle(a, "one");

      // A collaborator's view shares the tab: no new tab.
      const c = await open("frame:c", "someone-else");
      await activeTitle(c, "one");
      assert.equal(server.getState().tabs.length, 1);

      // My split gets its own tab with the same page, right away.
      let b = await open("frame:b");
      await tabCount(2)(b);
      await activeTitle(b, "one");
      await b.fill("#url", "data:text/html,<title>two</title>B");
      await b.press("#url", "Enter");
      await activeTitle(b, "two");
      // A (and the collaborator) still show their tab, and all stream.
      assert.match(await urlOf(a), /title>one/);
      assert.match(await urlOf(c), /title>one/);
      assert.ok((await frames(a)) > 0, "A was streamed its tab");
      assert.ok((await frames(b)) > 0, "B was streamed its tab");

      // A frame that reloads comes back to its own tab, without a new one.
      await b.close();
      b = await open("frame:b");
      await activeTitle(b, "two");
      assert.equal(server.getState().tabs.length, 2);
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

test(
  "a hidden viewer keeps the page's size and its last frame",
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
    const { port } = await server.start();
    const human = await chromium.launch({
      executablePath: executable,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    try {
      const viewer = await human.newPage({
        viewport: { width: 900, height: 600 },
      });
      await viewer.goto(`http://127.0.0.1:${port}/?view=frame:x&client=me`);
      await viewer.waitForFunction(
        () => document.getElementById("status")?.textContent === "live",
      );
      const stageWidth = await viewer.evaluate(() =>
        Math.round(
          document.getElementById("stage")!.getBoundingClientRect().width,
        ),
      );
      const deadline = Date.now() + 5000;
      while (
        server.getState().viewport.width !== stageWidth &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 100));
      const size = server.getState().viewport;
      assert.equal(size.width, stageWidth, "viewport follows the viewer");

      // Another tab or frame in front: the viewer's iframe collapses.
      await viewer.setViewportSize({ width: 1, height: 1 });
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(server.getState().viewport, size, "page not shrunk");

      // Shown again: the same size, streaming again.
      await viewer.setViewportSize({ width: 900, height: 600 });
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(server.getState().viewport, size);

      // Resizing the viewer after frames have arrived resizes the page.
      await viewer.setViewportSize({ width: 700, height: 500 });
      const narrower = Date.now() + 5000;
      while (server.getState().viewport.width >= 900 && Date.now() < narrower)
        await new Promise((r) => setTimeout(r, 100));
      assert.ok(
        server.getState().viewport.width < 900,
        "page follows the viewer's size",
      );

      // The last frame is kept for a viewer that is reloaded.
      await new Promise((r) => setTimeout(r, 2500));
      const saved = await viewer.evaluate(() =>
        Object.keys(sessionStorage).some((k) =>
          k.startsWith("cocalc-browser-frame:"),
        ),
      );
      assert.ok(saved, "last frame saved");
    } finally {
      await human.close().catch(() => {});
      await server.close();
      await browser.stop();
      await profile.cleanup();
    }
  },
);

test(
  "frames match the viewer's pixel ratio, with a lossless frame at rest",
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
    const human = await chromium.launch({
      executablePath: executable,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    try {
      const page = await SharedBrowserPage.open(`http://127.0.0.1:${cdpPort}`);
      await page.goto("data:text/html,<title>t</title><h1>Sharp text</h1>");
      page.close();
      const viewer = await human.newPage({
        viewport: { width: 800, height: 500 },
        deviceScaleFactor: 2,
      });
      // Record each frame's type and width as the viewer decodes it.
      await viewer.addInitScript(() => {
        const decode = window.createImageBitmap.bind(window);
        (window as any).__frames = [];
        (window as any).createImageBitmap = async (
          src: any,
          ...rest: any[]
        ) => {
          const bmp = await decode(src, ...rest);
          if (src instanceof Blob)
            (window as any).__frames.push({ type: src.type, width: bmp.width });
          return bmp;
        };
      });
      await viewer.goto(`http://127.0.0.1:${port}/`);
      const frames = () => viewer.evaluate(() => (window as any).__frames);
      const until = async (ok: (f: any[]) => boolean) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (ok(await frames())) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.fail(`frames: ${JSON.stringify(await frames())}`);
      };
      const stage = await viewer.evaluate(() =>
        Math.round(
          document.getElementById("stage")!.getBoundingClientRect().width,
        ),
      );
      // At rest, a frame at device pixels: twice the stage's width.
      await until((f) => f.some((x) => x.width === stage * 2));
      // ...and then nothing more while nothing changes (no capture loop).
      await new Promise((r) => setTimeout(r, 1000));
      const settled = (await frames()).length;
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal((await frames()).length, settled, "no frames at rest");
      const last = (await frames()).at(-1);
      assert.equal(last.width, stage * 2, "the sharp frame stays");

      // Fast: no full-resolution frame.
      await viewer.selectOption("#quality", "fast");
      await new Promise((r) => setTimeout(r, 500));
      await viewer.evaluate(() => ((window as any).__frames = []));
      const p2 = await SharedBrowserPage.open(`http://127.0.0.1:${cdpPort}`);
      await p2.evaluate("document.body.style.background = 'yellow'");
      p2.close();
      await until((f) => f.length > 0);
      await new Promise((r) => setTimeout(r, 1000));
      assert.ok(!(await frames()).some((x: any) => x.width === stage * 2));
    } finally {
      await human.close().catch(() => {});
      await server.close();
      await browser.stop();
      await profile.cleanup();
    }
  },
);
