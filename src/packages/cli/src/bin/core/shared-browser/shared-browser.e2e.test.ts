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
import { profileSecret, startBrowserKeyring } from "./keyring";
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
      // One paste, delivered the way a real paste arrives (on the field that
      // takes the keyboard).
      await viewer.evaluate(() => {
        const data = new DataTransfer();
        data.setData("text", "[pasted]");
        document
          .getElementById("keys")!
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

test(
  "the human's clipboard: copy a selection (keys and button), a page's own copy button, and paste",
  {
    skip: executable ? false : "no Chrome/Chromium installed",
    timeout: 120_000,
  },
  async () => {
    const { chromium } = require("playwright-core");
    const { createServer } = require("node:http");
    // On 127.0.0.1, a secure context: the page has navigator.clipboard.
    const site = createServer((_req: any, res: any) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<title>clip</title><p id=p style="font:30px sans-serif;margin:0;padding:4px">Hello copy world</p>` +
          `<input id=t style="font-size:20px;width:400px"><button id=b style="font-size:20px" onclick="navigator.clipboard.writeText('from the page button')">copy</button>`,
      );
    });
    await new Promise<void>((resolve) =>
      site.listen(0, "127.0.0.1", () => resolve()),
    );
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
      await page.goto(`http://127.0.0.1:${site.address().port}/`);
      const context = await human.newContext({
        viewport: { width: 900, height: 600 },
      });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: `http://127.0.0.1:${port}`,
      });
      const viewer = await context.newPage();
      await viewer.goto(`http://127.0.0.1:${port}/`);
      await viewer.waitForFunction(
        () => document.getElementById("status")?.textContent === "live",
      );
      // Where things are, at the viewer's size (asked while the agent drives).
      await page.waitForFunction(() => innerWidth > 0 && innerWidth <= 900);
      await new Promise((r) => setTimeout(r, 500));
      const at = await page.evaluate(() =>
        Object.fromEntries(
          ["p", "t", "b"].map((id) => {
            const r = document.getElementById(id)!.getBoundingClientRect();
            return [id, { x: r.x + 10, y: r.y + r.height / 2 }];
          }),
        ),
      );
      await viewer.click("#driver button"); // take over
      await viewer.waitForFunction(() =>
        document
          .querySelector("#driver button")
          ?.textContent?.startsWith("Hand back"),
      );
      const canvas = (await viewer.locator("#screen").boundingBox())!;
      const click = (p: { x: number; y: number }, clickCount = 1) =>
        viewer.mouse.click(canvas.x + p.x, canvas.y + p.y, { clickCount });
      const clipboard = () =>
        viewer.evaluate(() => navigator.clipboard.readText());
      const until = async (ok: () => Promise<boolean>, what: string) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (await ok()) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.fail(`${what}: clipboard has ${JSON.stringify(await clipboard())}`);
      };

      // Select the paragraph in the page, and copy it with the keyboard.
      await click(at.p, 3);
      await viewer.waitForFunction(
        () => getComputedStyle(document.getElementById("copy")!).display !== "none",
      );
      await viewer.keyboard.press("Control+C");
      await until(
        async () => (await clipboard()).trim() === "Hello copy world",
        "copied with the keyboard",
      );

      // The Copy button.
      await viewer.evaluate(() => navigator.clipboard.writeText("other"));
      await viewer.click("#copy");
      await until(
        async () => (await clipboard()).trim() === "Hello copy world",
        "copied with the button",
      );

      // The page's own copy button reaches the human's clipboard.
      await click(at.b);
      await until(
        async () => (await clipboard()) === "from the page button",
        "the page's copy",
      );

      // Paste from the clipboard into the page.
      await viewer.evaluate(() =>
        navigator.clipboard.writeText("pasted from the clipboard"),
      );
      await click(at.t);
      await viewer.keyboard.press("Control+V");
      await new Promise((r) => setTimeout(r, 500));

      // On a Mac or iPad, Cmd does what Ctrl does in the page: Cmd+A selects
      // the field's text, which the viewer then holds for a copy.
      const mac = await context.newPage();
      await mac.addInitScript(() =>
        Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }),
      );
      await mac.goto(`http://127.0.0.1:${port}/`);
      await mac.waitForFunction(
        () => document.getElementById("status")?.textContent === "live",
      );
      const macCanvas = (await mac.locator("#screen").boundingBox())!;
      await mac.mouse.click(macCanvas.x + at.t.x, macCanvas.y + at.t.y);
      await mac.keyboard.press("Meta+A");
      await mac.waitForFunction(
        () =>
          (document.getElementById("keys") as HTMLTextAreaElement).value ===
          "pasted from the clipboard",
      );
      await mac.close();
      await viewer.click("#driver button"); // hand back
      assert.equal(
        await page.$eval("#t", (el: HTMLInputElement) => el.value),
        "pasted from the clipboard",
      );
    } finally {
      await agent.close().catch(() => {});
      await human.close().catch(() => {});
      await server.close();
      await browser.stop();
      await profile.cleanup();
      site.close();
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
      // Sites must not be told the browser is automated (X refuses logins).
      assert.equal(await page.evaluate("navigator.webdriver"), false);
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
  "sign-ins are kept encrypted with the project's browser key, and lost with another key",
  {
    skip: executable ? false : "no Chrome/Chromium installed",
    timeout: 120_000,
  },
  async () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { createServer } = require("node:http");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const { DatabaseSync } = require("node:sqlite");
    const { chromium } = require("playwright-core");
    const site = createServer((_req, res) => {
      res.setHeader(
        "Set-Cookie",
        "session=signed-in-token; Max-Age=86400; Path=/",
      );
      res.end("ok");
    });
    await new Promise<void>((resolve) =>
      site.listen(0, "127.0.0.1", () => resolve()),
    );
    const url = `http://127.0.0.1:${site.address().port}/`;
    const profileDir = mkdtempSync(join(tmpdir(), "cocalc-browser-keyring-"));
    // Visit the site (signing in), or just look at the cookies kept.
    const run = async (secret: Buffer, visit: boolean) => {
      const keyring = await startBrowserKeyring({ secret });
      const browser = await launchBrowser({
        executable: executable!,
        profileDir,
        args: sharedBrowserChromeArgs(profileDir),
        env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: keyring.address },
      });
      try {
        const cdp = await chromium.connectOverCDP(
          `http://127.0.0.1:${browser.port}`,
        );
        const context = cdp.contexts()[0];
        if (visit) await context.pages()[0].goto(url);
        const values = (await context.cookies())
          .filter((c: any) => c.name === "session")
          .map((c: any) => c.value);
        await cdp.close().catch(() => {});
        return values;
      } finally {
        await browser.stop();
        await keyring.close();
      }
    };
    const a = profileSecret(Buffer.from("project key A, long enough"), "x");
    const b = profileSecret(Buffer.from("project key B, long enough"), "x");
    try {
      assert.deepEqual(await run(a, true), ["signed-in-token"]);
      // On disk, encrypted with our key ("v11"), not Chromium's built-in
      // one ("v10"), and not in the clear.
      // (A wrapper script's Chromium may hold the database a moment longer.)
      let rows: any[] = [];
      for (let attempt = 0; ; attempt++) {
        try {
          const db = new DatabaseSync(join(profileDir, "Default", "Cookies"), {
            readOnly: true,
          });
          try {
            rows = db
              .prepare(
                "SELECT value, hex(substr(encrypted_value, 1, 3)) AS prefix FROM cookies WHERE name = 'session'",
              )
              .all();
          } finally {
            db.close();
          }
          break;
        } catch (err) {
          if (attempt >= 40 || !/locked|busy/.test(`${err}`)) throw err;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      assert.deepEqual(
        rows.map((r: any) => [r.value, r.prefix]),
        [["", "763131"]],
      );
      assert.deepEqual(await run(a, false), ["signed-in-token"]);
      assert.deepEqual(await run(b, false), []);
    } finally {
      site.close();
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
  "a still page gets one lossless frame at the stream's size, then nothing",
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
          if (src instanceof Blob) {
            const head = new Uint8Array(await src.slice(0, 1).arrayBuffer())[0];
            (window as any).__frames.push({
              type: head === 0x89 ? "png" : "jpeg",
              width: bmp.width,
            });
          }
          return bmp;
        };
      });
      await viewer.goto(`http://127.0.0.1:${port}/`);
      await viewer.selectOption("#quality", "sharp");
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
      // At rest: a lossless frame, at the stream's (the page's) size...
      await until((f) => f.some((x) => x.type === "png" && x.width === stage));
      // ...and then nothing more while nothing changes (no capture loop).
      await new Promise((r) => setTimeout(r, 1000));
      const settled = (await frames()).length;
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(
        (await frames()).length,
        settled,
        `no frames at rest: ${JSON.stringify((await frames()).slice(settled - 2))}`,
      );
      assert.equal(
        (await frames()).at(-1).type,
        "png",
        "the lossless frame stays",
      );

      // Fast: stream frames only.
      await viewer.selectOption("#quality", "fast");
      await new Promise((r) => setTimeout(r, 500));
      await viewer.evaluate(() => ((window as any).__frames = []));
      const p2 = await SharedBrowserPage.open(`http://127.0.0.1:${cdpPort}`);
      await p2.evaluate("document.body.style.background = 'yellow'");
      p2.close();
      await until((f) => f.length > 0);
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(!(await frames()).some((x: any) => x.type === "png"));
    } finally {
      await human.close().catch(() => {});
      await server.close();
      await browser.stop();
      await profile.cleanup();
    }
  },
);

test(
  "clicks land where the human clicks, at any pixel ratio",
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
      await page.goto(
        "data:text/html,<body style='margin:0'><script>addEventListener('mousedown',e=>document.title=e.clientX+','+e.clientY+','+innerWidth)</script></body>",
      );
      page.close();
      const results: any[] = [];
      for (const dpr of [1, 1.5, 2, 2.5, 3]) {
        const viewer = await human.newPage({
          // Wider than the headless window (1280): clicks far right matter.
          viewport: { width: 1500, height: 700 },
          deviceScaleFactor: dpr,
        });
        await viewer.goto(
          `http://127.0.0.1:${port}/?view=frame:d${String(dpr).replace(".", "_")}`,
        );
        await viewer.waitForFunction(
          () => document.getElementById("status")?.textContent === "live",
        );
        await viewer.click("#driver button"); // take over
        // Let the viewport, pixel ratio and the sharp frame settle.
        await new Promise((r) => setTimeout(r, 1500));
        const box = await viewer.locator("#screen").boundingBox();
        await viewer.mouse.click(box!.x + 1000, box!.y + 100);
        await new Promise((r) => setTimeout(r, 500));
        await viewer.click("#driver button"); // hand back
        const p = await SharedBrowserPage.open(
          `http://127.0.0.1:${cdpPort}`,
          server.getState().active,
        );
        const [x, y, width] = (await p.location()).title.split(",").map(Number);
        p.close();
        results.push({ dpr, x, y, width, canvas: Math.round(box!.width) });
        await viewer.close();
      }
      for (const r of results) {
        assert.equal(
          r.width,
          r.canvas,
          `page width = canvas width ${JSON.stringify(r)}`,
        );
        assert.ok(
          Math.abs(r.x - 1000) <= 1 && Math.abs(r.y - 100) <= 1,
          JSON.stringify(r),
        );
      }
    } finally {
      await human.close().catch(() => {});
      await server.close();
      await browser.stop();
      await profile.cleanup();
    }
  },
);

// Stand-in for the reverse ssh tunnel: a TCP forward from a port in the
// "project" to the browser on the "computer".  `close()` drops it.
async function tcpForward(targetPort: number, listenPort = 0) {
  const net = require("node:net");
  const sockets = new Set<any>();
  const server = net.createServer((client: any) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  });
  await new Promise<void>((r) => server.listen(listenPort, "127.0.0.1", r));
  return {
    port: server.address().port as number,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

test(
  "a browser on the user's computer: waiting, attach through a tunnel, drop, switch",
  {
    skip: executable ? false : "no Chrome/Chromium installed",
    timeout: 120_000,
  },
  async () => {
    const { chromium } = require("playwright-core");
    const switched: string[] = [];
    const server = new SharedBrowserServer({
      host: "127.0.0.1",
      port: 0,
      cdpPort: 0,
      humanFirst: true,
      runsOn: "computer",
      connectCommand:
        "cocalc project browser connect -w p --browser /home/user/t.browser",
      onRunsOn: (value) => {
        switched.push(value);
      },
    });
    const { port, cdpPort } = await server.start();
    // The "computer": its own Chrome.
    const profile = await createProfileDir("disk", sys);
    const laptop = await launchBrowser({
      executable: executable!,
      profileDir: profile.path,
      args: sharedBrowserChromeArgs(profile.path),
    });
    const human = await chromium.launch({
      executablePath: executable,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    let tunnel: Awaited<ReturnType<typeof tcpForward>> | null = null;
    try {
      // Waiting: the viewer shows how to connect; agents get a clear error.
      const viewer = await human.newPage({
        viewport: { width: 800, height: 500 },
      });
      // The CoCalc page passes the site it is on (the viewer itself is
      // served from the project host's domain).
      await viewer.goto(
        `http://127.0.0.1:${port}/?view=frame:w&client=me&site=${encodeURIComponent("https://example.cocalc.ai")}`,
      );
      await viewer.waitForSelector("#waiting", { state: "visible" });
      assert.match(
        await viewer.textContent("#waiting pre"),
        /connect -w p --browser \/home\/user\/t\.browser/,
      );
      await assert.rejects(
        SharedBrowserPage.open(`http://127.0.0.1:${cdpPort}`),
        /user's computer/,
      );

      // The computer connects (through the tunnel, which reports another port).
      tunnel = await tcpForward(laptop.port);
      const version = await (
        await fetch(`http://127.0.0.1:${tunnel.port}/json/version`)
      ).json();
      await server.attachChrome(
        version.webSocketDebuggerUrl.replace(
          /^ws:\/\/[^/]+/,
          `ws://127.0.0.1:${tunnel.port}`,
        ),
      );
      await viewer.waitForSelector("#waiting", { state: "hidden" });
      // The connect command names this site.
      assert.match(
        server.getState().connectCommand!,
        /--api https:\/\/example\.cocalc\.ai$/,
      );
      // A preview streams; the human is told to use the window.
      await viewer.waitForFunction(() =>
        document
          .querySelector("#driver .msg")
          ?.textContent?.includes("Chrome on your computer"),
      );
      await viewer.click("#screen");
      await viewer.waitForSelector("#notdriving", { state: "visible" });
      assert.match(
        await viewer.textContent("#notdriving p"),
        /use that window/,
      );
      // Agents reach it through our endpoint (addresses rewritten).
      const page = await SharedBrowserPage.open(
        `http://127.0.0.1:${cdpPort}`,
        server.getState().active,
      );
      await viewer.click("#driver button"); // the human hands back
      assert.equal(
        (await page.goto("data:text/html,<title>on the laptop</title>")).title,
        "on the laptop",
      );
      // Light touch: the real window's size, and nothing of ours in the page.
      assert.deepEqual(
        await page.evaluate(
          "[innerWidth, typeof window.__cocalcSelectHooked, typeof window.__cocalcSharedBrowserSelect]",
        ),
        [1280, "undefined", "undefined"],
      );
      page.close();

      // The tunnel drops: back to waiting, nothing hangs.
      await tunnel.close();
      tunnel = null;
      await viewer.waitForSelector("#waiting", { state: "visible" });
      assert.equal(server.getState().connection, "waiting");

      // The viewer's switch asks to run it in the project instead.
      await viewer.click('#waiting button[data-a="project"]');
      const deadline = Date.now() + 5000;
      while (!switched.length && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(switched, ["project"]);
    } finally {
      await tunnel?.close();
      await human.close().catch(() => {});
      await server.close();
      await laptop.stop();
      await profile.cleanup();
    }
  },
);

test(
  "serve --browser follows the file and a computer that connects",
  {
    skip: executable ? false : "no Chrome/Chromium installed",
    timeout: 180_000,
  },
  async () => {
    const { spawn } = require("node:child_process");
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const net = require("node:net");
    const {
      sharedBrowserFileAppId,
      sharedBrowserTunnelPort,
    } = require("@cocalc/util/shared-browser");
    const home = mkdtempSync(join(tmpdir(), "cocalc-serve-home-"));
    const file = join(home, "t.browser");
    const tunnelPort = sharedBrowserTunnelPort(sharedBrowserFileAppId(file));
    const appPort: number = await new Promise((r) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => r(p));
      });
    });
    // Tests run in packages/cli.
    const cli = join(process.cwd(), "dist/bin/cocalc.js");
    const serve = spawn(
      process.execPath,
      [
        cli,
        "project",
        "browser",
        "serve",
        "--browser",
        file,
        "--port",
        `${appPort}`,
        "--cdp-port",
        "0",
      ],
      {
        env: { ...process.env, HOME: home, COCALC_CHROME: executable },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let log = "";
    serve.stderr.on("data", (d: Buffer) => (log += d.toString()));
    const state = async () => {
      try {
        return await (
          await fetch(`http://127.0.0.1:${appPort}/api/state`)
        ).json();
      } catch {
        return null;
      }
    };
    const until = async (ok: (s: any) => boolean, what: string) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const s = await state();
        if (s && ok(s)) return s;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.fail(`${what}: ${JSON.stringify(await state())}\n${log}`);
    };
    const profile = await createProfileDir("disk", sys);
    let laptop: Awaited<ReturnType<typeof launchBrowser>> | null = null;
    let tunnel: Awaited<ReturnType<typeof tcpForward>> | null = null;
    try {
      // No file yet: it runs in the project.
      await until(
        (s) => s.runsOn === "project" && s.connection === "connected",
        "in the project",
      );

      // The file says: on my computer.  Nobody connected yet: waiting.
      writeFileSync(file, JSON.stringify({ runs_on: "computer" }));
      await until(
        (s) => s.runsOn === "computer" && s.connection === "waiting",
        "waiting",
      );

      // The computer connects: attached.
      laptop = await launchBrowser({
        executable: executable!,
        profileDir: profile.path,
        args: sharedBrowserChromeArgs(profile.path),
      });
      tunnel = await tcpForward(laptop.port, tunnelPort);
      await until(
        (s) => s.connection === "connected",
        "attached to the computer",
      );

      // Back to the project (e.g. the viewer's switch wrote the file).
      writeFileSync(file, JSON.stringify({ runs_on: "project" }));
      await until(
        (s) => s.runsOn === "project" && s.connection === "connected",
        "back in the project",
      );
      await tunnel.close();
      tunnel = null;

      // A computer that connects takes over the file's browser by itself.
      tunnel = await tcpForward(laptop.port, tunnelPort);
      await until(
        (s) => s.runsOn === "computer" && s.connection === "connected",
        "switched by connecting",
      );
      assert.match(require("node:fs").readFileSync(file, "utf8"), /"computer"/);
    } finally {
      if (serve.exitCode === null && serve.signalCode === null) {
        serve.kill("SIGTERM");
        await new Promise((r) => serve.once("exit", r));
      }
      await tunnel?.close();
      await laptop?.stop();
      await profile.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "after scrolling, a still page gets one sharp frame, not a flicker",
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
      await page.goto(
        "data:text/html,<body style='margin:0'>" +
          "<p>line</p>".repeat(300) +
          "</body>",
      );
      page.close();
      const viewer = await human.newPage({
        viewport: { width: 900, height: 600 },
        deviceScaleFactor: 2,
      });
      await viewer.addInitScript(() => {
        const decode = window.createImageBitmap.bind(window);
        (window as any).__frames = [];
        (window as any).createImageBitmap = async (
          src: any,
          ...rest: any[]
        ) => {
          const bmp = await decode(src, ...rest);
          if (src instanceof Blob)
            (window as any).__frames.push({
              width: bmp.width,
              height: bmp.height,
            });
          return bmp;
        };
      });
      await viewer.goto(`http://127.0.0.1:${port}/`);
      await viewer.waitForFunction(
        () => document.getElementById("status")?.textContent === "live",
      );
      await viewer.click("#driver button"); // take over
      const box = await viewer.locator("#screen").boundingBox();
      await viewer.mouse.move(box!.x + 200, box!.y + 200);
      for (let i = 0; i < 5; i++) {
        await viewer.mouse.wheel(0, 300);
        await new Promise((r) => setTimeout(r, 100));
      }
      // Let it settle, then nothing more should arrive.
      await new Promise((r) => setTimeout(r, 2500));
      const settled = await viewer.evaluate(
        () => (window as any).__frames.length,
      );
      await new Promise((r) => setTimeout(r, 3000));
      const frames = await viewer.evaluate(() => (window as any).__frames);
      assert.equal(
        frames.length,
        settled,
        `frames at rest: ${JSON.stringify(frames.slice(settled))}`,
      );
      // The still frame has the stream's proportions (no grey strip).
      const last = frames.at(-1);
      const stream =
        frames.find((f: any) => f.width * 2 === last.width) ?? last;
      assert.ok(
        Math.abs(last.width / last.height - stream.width / stream.height) <
          0.01,
        `still ${JSON.stringify(last)} vs stream ${JSON.stringify(stream)}`,
      );
    } finally {
      await human.close().catch(() => {});
      await server.close();
      await browser.stop();
      await profile.cleanup();
    }
  },
);

test(
  "serve keeps the chat browser's sign-ins with the project's browser key, and forgets them when the key changes",
  {
    skip: executable ? false : "no Chrome/Chromium installed",
    timeout: 180_000,
  },
  async () => {
    const { spawn } = require("node:child_process");
    const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } =
      require("node:fs");
    const { createServer } = require("node:http");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const net = require("node:net");
    const { chromium } = require("playwright-core");
    const {
      SHARED_BROWSER_KEY_SECRET,
    } = require("@cocalc/util/shared-browser");
    const home = mkdtempSync(join(tmpdir(), "cocalc-serve-key-"));
    const secrets = join(home, "secrets");
    mkdirSync(secrets);
    const keyFile = join(secrets, SHARED_BROWSER_KEY_SECRET);
    const profileDir = join(
      home,
      ".local/share/cocalc/browser-profiles/cocalc-browser",
    );
    // Signing in sets the cookie; other pages only show it.
    const site = createServer((req, res) => {
      if (req.url === "/sign-in")
        res.setHeader("Set-Cookie", "session=signed-in; Max-Age=86400; Path=/");
      res.end("ok");
    });
    await new Promise<void>((resolve) =>
      site.listen(0, "127.0.0.1", () => resolve()),
    );
    const origin = `http://127.0.0.1:${site.address().port}`;
    const url = `${origin}/home`;
    const appPort: number = await new Promise((r) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => r(p));
      });
    });
    const cli = join(process.cwd(), "dist/bin/cocalc.js");
    let log = "";
    let serve: any = null;
    const start = () => {
      serve = spawn(
        process.execPath,
        [
          cli,
          "project",
          "browser",
          "serve",
          "--port",
          `${appPort}`,
          "--cdp-port",
          "0",
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            COCALC_SECRETS: secrets,
            COCALC_CHROME: executable,
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      serve.stderr.on("data", (d: Buffer) => (log += d.toString()));
    };
    const stopServe = async () => {
      if (!serve) return;
      const exited = new Promise((r) => serve.once("exit", r));
      serve.kill("SIGTERM");
      await exited;
      serve = null;
    };
    const state = async () => {
      try {
        return await (
          await fetch(`http://127.0.0.1:${appPort}/api/state`)
        ).json();
      } catch {
        return null;
      }
    };
    const until = async (ok: () => Promise<boolean> | boolean, what: string) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await ok()) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.fail(`${what}: ${JSON.stringify(await state())}\n${log}`);
    };
    const connected = async () => (await state())?.connection === "connected";
    // What the agent sees: the session cookie, and the pages open.
    const look = async (visit = false) => {
      const cdp = await chromium.connectOverCDP((await state()).cdp);
      try {
        const context = cdp.contexts()[0];
        if (visit) {
          await context.pages()[0].goto(`${origin}/sign-in`);
          await context.pages()[0].goto(url);
        }
        return {
          cookies: (await context.cookies())
            .filter((c: any) => c.name === "session")
            .map((c: any) => c.value),
          pages: context.pages().map((p: any) => p.url()),
        };
      } finally {
        await cdp.close().catch(() => {});
      }
    };
    try {
      writeFileSync(keyFile, "project browser key A, long enough\n");
      start();
      await until(
        () => /sign-ins encrypted with the project's browser key/.test(log),
        "started with the key",
      );
      await until(connected, "started");
      assert.deepEqual((await look(true)).cookies, ["signed-in"]);

      // Kept across restarts (e.g. the project restarted).
      await stopServe();
      start();
      await until(connected, "restarted");
      assert.deepEqual((await look()).cookies, ["signed-in"]);
      await look(true);

      // A new key (the "forget sign-ins" button): signed out, same pages.
      writeFileSync(keyFile, "project browser key B, long enough\n");
      await until(
        () => /key changed: restarting/.test(log),
        "noticed the new key",
      );
      await until(connected, "restarted with the new key");
      let seen = await look();
      assert.deepEqual(seen.cookies, []);
      assert.ok(seen.pages.includes(url), JSON.stringify(seen.pages));

      // No key (the secret was deleted): nothing kept at all.
      await look(true);
      rmSync(keyFile);
      await until(
        () => /sign-ins are not kept/.test(log),
        "noticed the key is gone",
      );
      await until(connected, "restarted without a key");
      assert.equal(existsSync(profileDir), false);
      seen = await look();
      assert.deepEqual(seen.cookies, []);
    } finally {
      await stopServe().catch(() => {});
      site.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
