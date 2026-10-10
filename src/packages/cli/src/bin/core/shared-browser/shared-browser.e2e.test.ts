// End to end: a real Chromium behind the shared browser server, an agent
// over CDP (Playwright) and a "human" using the viewer protocol, as CoCalc's
// frontend viewer does (the viewer's own input handling is tested in the
// frontend).  Skipped when no Chrome/Chromium is installed.
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ServiceMessage,
  SharedBrowserState,
  StartPageData,
  ViewerMessage,
  ViewerRequest,
} from "@cocalc/util/shared-browser-protocol";
import { keyMessage } from "@cocalc/util/shared-browser-input";

import {
  createProfileDir,
  defaultLocalBrowserSystem,
  findChrome,
  launchBrowser,
} from "../local-browser";
import { SharedBrowserPage } from "./agent-page";
import { CdpClient } from "./cdp-client";
import { profileSecret, startBrowserKeyring } from "./keyring";
import {
  SharedBrowserServer,
  type ViewerChannel,
  type ViewerHello,
} from "./server";
import { sharedBrowserChromeArgs } from "./service";

const sys = defaultLocalBrowserSystem();
let executable: string | undefined;
try {
  executable = findChrome(undefined, sys);
} catch {
  executable = undefined;
}

const needsChrome = {
  skip: executable ? false : "no Chrome/Chromium installed",
  timeout: 120_000,
};

async function until<T>(
  get: () => T | Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await get();
    if (ok(value)) return value;
    if (Date.now() > deadline)
      assert.fail(`${what}: ${JSON.stringify(value)?.slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A viewer, as CoCalc's frontend is one: says hello, sizes the page, and
 * sends the human's input; collects what the browser sends it.
 */
class TestViewer implements ViewerChannel {
  state: SharedBrowserState | null = null;
  selection = "";
  copied: string[] = [];
  errors: string[] = [];
  frames: Buffer[] = [];

  constructor(
    private readonly server: SharedBrowserServer,
    hello: ViewerHello = {},
  ) {
    server.addViewer(this, hello);
  }

  send(message: ServiceMessage): void {
    if (message.type === "state") this.state = message.state;
    else if (message.type === "selection") this.selection = message.text;
    else if (message.type === "copied") this.copied.push(message.text);
    else if (message.type === "error") this.errors.push(message.message);
  }

  sendFrame(frame: Buffer): void {
    this.frames.push(frame);
  }

  say(message: ViewerMessage): Promise<void> {
    return this.server.viewerMessage(this, message);
  }

  ask(request: ViewerRequest): Promise<any> {
    return this.server.viewerRequest(this, request);
  }

  close(): void {
    this.server.removeViewer(this);
  }

  async resize(width: number, height: number, quality = "balanced") {
    await this.say({ type: "resize", width, height, quality } as any);
    await until(
      () => this.state?.viewport,
      (v) => v?.width === width && v?.height === height,
      "the page took the viewer's size",
    );
  }

  async takeOver() {
    await this.say({ type: "takeover" });
    await until(
      () => this.state?.driver,
      (d) => d === "human",
      "driving",
    );
  }

  async handBack() {
    await this.say({ type: "handback" });
    await until(
      () => this.state?.driver,
      (d) => d === "agent",
      "handed back",
    );
  }

  // A click where the human sees it (the viewer's pixels).
  async click(x: number, y: number, clickCount = 1) {
    for (const event of ["mousePressed", "mouseReleased"] as const)
      await this.say({
        type: "mouse",
        event,
        x,
        y,
        button: "left",
        buttons: event === "mousePressed" ? 1 : 0,
        clickCount,
      });
  }

  // Typing, key by key, as the frontend turns keys into messages.  Key
  // codes as the worst browser reports them (0 for punctuation).
  async type(text: string, { apple = false, meta = false } = {}) {
    for (const char of text) {
      const e = {
        key: char,
        code: "",
        keyCode: 0,
        altKey: false,
        ctrlKey: false,
        metaKey: meta,
        shiftKey: /[A-Z(){}%&"_+!@#$^*<>?:|~]/.test(char),
      };
      await this.say(keyMessage("keyDown", e, apple));
      await this.say(keyMessage("keyUp", e, apple));
    }
  }
}

// An image's size, from its PNG or JPEG header.
function imageSize(image: Buffer): {
  type: "png" | "jpeg";
  width: number;
  height: number;
} {
  if (image[0] === 0x89)
    return {
      type: "png",
      width: image.readUInt32BE(16),
      height: image.readUInt32BE(20),
    };
  for (let i = 2; i + 9 < image.length; ) {
    if (image[i] !== 0xff) break;
    const marker = image[i + 1];
    const length = image.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3)
      return {
        type: "jpeg",
        height: image.readUInt16BE(i + 5),
        width: image.readUInt16BE(i + 7),
      };
    i += 2 + length;
  }
  return { type: "jpeg", width: 0, height: 0 };
}

// A browser and the server around it, for one test.
async function sharedBrowser(
  options: Partial<ConstructorParameters<typeof SharedBrowserServer>[0]> = {},
) {
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
    ...options,
  });
  const { port, cdpPort } = await server.start();
  return {
    server,
    port,
    cdpPort,
    version,
    close: async () => {
      await server.close();
      await browser.stop();
      await profile.cleanup();
    },
  };
}

// The environment of a `serve` the tests start: never with this project's
// CoCalc credentials (it would serve viewers of the real browser).
function withoutCoCalcCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "COCALC_SECRET_TOKEN",
    "COCALC_PROJECT_ID",
    "COCALC_API_URL",
    "COCALC_BEARER_TOKEN",
    "COCALC_API_KEY",
  ])
    delete env[name];
  return env;
}

const PAGE =
  "data:text/html,<title>t</title><input id=t autofocus style='width:600px'>";

test(
  "the human types any character and pastes once; the agent sees it after hand-back",
  needsChrome,
  async () => {
    const { chromium } = require("playwright-core");
    const shared = await sharedBrowser();
    const agent = await chromium.connectOverCDP(
      `http://127.0.0.1:${shared.cdpPort}`,
    );
    try {
      const page = agent.contexts()[0].pages()[0];
      await page.goto(PAGE);
      const viewer = new TestViewer(shared.server);
      await viewer.resize(900, 560);
      await viewer.takeOver();
      // Into the input (top-left of the page): characters whose char codes
      // collide with navigation key codes, e.g. "(" = ArrowDown.
      await viewer.click(40, 18);
      const typed = `f(x) = 'a' . 100% & "b"`;
      await viewer.type(typed);
      await viewer.say({ type: "text", text: "[pasted]" });
      await sleep(300);
      await viewer.handBack();
      assert.equal(
        await page.$eval("#t", (el: HTMLInputElement) => el.value),
        `${typed}[pasted]`,
      );
    } finally {
      await agent.close().catch(() => {});
      await shared.close();
    }
  },
);

test(
  "the human's clipboard: the page's selection and its own copy button reach the viewer; Cmd works as Ctrl",
  needsChrome,
  async () => {
    const { chromium } = require("playwright-core");
    const { createServer } = require("node:http");
    // On 127.0.0.1, a secure context: the page has navigator.clipboard.
    const site = createServer((_req: any, res: any) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<title>clip</title><p id=p style="font:30px sans-serif;margin:0;padding:4px">Hello copy world</p>` +
          `<input id=t style="font-size:20px;width:400px" value="in the field"><button id=b style="font-size:20px" onclick="navigator.clipboard.writeText('from the page button')">copy</button>`,
      );
    });
    await new Promise<void>((resolve) =>
      site.listen(0, "127.0.0.1", () => resolve()),
    );
    const shared = await sharedBrowser();
    const agent = await chromium.connectOverCDP(
      `http://127.0.0.1:${shared.cdpPort}`,
    );
    try {
      const page = agent.contexts()[0].pages()[0];
      await page.goto(`http://127.0.0.1:${site.address().port}/`);
      const viewer = new TestViewer(shared.server);
      await viewer.resize(900, 560);
      await sleep(300);
      const at = await page.evaluate(() =>
        Object.fromEntries(
          ["p", "t", "b"].map((id) => {
            const r = document.getElementById(id)!.getBoundingClientRect();
            return [id, { x: r.x + 10, y: r.y + r.height / 2 }];
          }),
        ),
      );
      await viewer.takeOver();
      // Selecting the paragraph: the viewer holds it, for a copy.
      await viewer.click(at.p.x, at.p.y, 1);
      await viewer.click(at.p.x, at.p.y, 2);
      await viewer.click(at.p.x, at.p.y, 3);
      await until(
        () => viewer.selection.trim(),
        (s) => s === "Hello copy world",
        "the selection",
      );
      // The page's own copy button.
      await viewer.click(at.b.x, at.b.y);
      await until(
        () => viewer.copied,
        (c) => c.includes("from the page button"),
        "the page's copy",
      );
      // On a Mac or iPad, Cmd does what Ctrl does in the page: Cmd+A
      // selects the field's text.
      await viewer.click(at.t.x, at.t.y);
      await viewer.type("a", { apple: true, meta: true });
      await until(
        () => viewer.selection,
        (s) => s === "in the field",
        "Cmd+A selected the field",
      );
      // Paste into the field.
      await viewer.say({ type: "text", text: " pasted" });
      await viewer.handBack();
      // (Cmd+A selected all of it, so the paste replaced it.)
      assert.equal(
        await page.$eval("#t", (el: HTMLInputElement) => el.value),
        " pasted",
      );
    } finally {
      await agent.close().catch(() => {});
      await shared.close();
      site.close();
    }
  },
);

test(
  "a new tab's start page offers the project's servers and recent sites; tabs know their site icons",
  needsChrome,
  async () => {
    const { createServer } = require("node:http");
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const site = createServer((req: any, res: any) => {
      if (req.url === "/icon.png") {
        res.setHeader("content-type", "image/png");
        res.end(PNG);
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        `<title>My dev app</title><link rel=icon href="/icon.png"><h1 style="font-size:60px">Hello dev app</h1>`,
      );
    });
    await new Promise<void>((resolve) =>
      site.listen(0, "127.0.0.1", () => resolve()),
    );
    const sitePort = site.address().port;
    const shared = await sharedBrowser({
      humanFirst: true,
      title: "work.browser",
      startPagePorts: [sitePort],
    });
    try {
      const viewer = new TestViewer(shared.server, {
        view: "frame:s",
        client: "me",
      });
      await viewer.resize(960, 600);
      assert.equal(viewer.state?.title, "work.browser");
      const start: StartPageData = await viewer.ask({ type: "start" });
      const server = start.servers.find((s) => s.port === sitePort);
      assert.ok(server, JSON.stringify(start));
      assert.equal(server.url, `http://localhost:${sitePort}/`);
      assert.match(server.label, /My dev app/);
      await viewer.say({ type: "navigate", url: server.url });
      // The tab knows the site's icon...
      const tab = await until(
        () => viewer.state?.tabs.find((t) => t.id === viewer.state?.active),
        (t) => !!t?.icon,
        "the tab's icon",
      );
      assert.equal(tab?.icon, `http://localhost:${sitePort}/icon.png`);
      // ...but the browser service fetches icons from public sites only,
      // never the project's own servers.
      assert.equal(
        await viewer.ask({ type: "favicon", url: tab!.icon! }),
        null,
      );
      // The visit is now a recent site?  Local addresses are listed as
      // servers instead.
      const again: StartPageData = await viewer.ask({ type: "start" });
      assert.equal(
        again.recent.some((r) => r.url.includes("localhost")),
        false,
      );
    } finally {
      await shared.close();
      site.close();
    }
  },
);

test(
  "page zoom: the page lays out as a zoomed browser's would, and clicks still land (also after screenshots)",
  needsChrome,
  async () => {
    const { chromium } = require("playwright-core");
    const ZOOM_PAGE =
      "data:text/html," +
      encodeURIComponent(
        `<title>z</title><style>body{margin:0}@media (max-width:600px){#mq{color:rgb(255,0,0)}}</style><div id=mq>mq</div>` +
          `<button id=b style="position:absolute;left:300px;top:200px;width:100px;height:40px" onclick="document.title='clicked '+(++window.n)">B</button><script>window.n=0</script>`,
      );
    const shared = await sharedBrowser();
    const agent = await chromium.connectOverCDP(
      `http://127.0.0.1:${shared.cdpPort}`,
    );
    try {
      const page = agent.contexts()[0].pages()[0];
      await page.goto(ZOOM_PAGE);
      const viewer = new TestViewer(shared.server);
      await viewer.resize(1000, 640);
      await page.waitForFunction(() => innerWidth === 1000);

      // Zoom to 200%, just watching (the agent drives).
      await viewer.say({ type: "zoom", zoom: 2 });
      await page.waitForFunction(() => devicePixelRatio === 2);
      // Half as wide, so the narrow layout applies, as in a zoomed browser.
      assert.deepEqual(
        await page.evaluate(() => [
          innerWidth,
          getComputedStyle(document.getElementById("mq")!).color,
        ]),
        [500, "rgb(255, 0, 0)"],
      );
      assert.equal(shared.server.getState().zoom, 2);
      assert.equal(viewer.state?.zoom, 2);

      // The human clicks the (twice as large) button where they see it.
      const clickButton = async () => {
        await viewer.takeOver();
        await viewer.click(2 * 350, 2 * 220);
        await sleep(300);
        await viewer.handBack();
      };
      await clickButton();
      assert.equal(await page.title(), "clicked 1");
      // A screenshot (the agent's) does not shift where clicks land...
      assert.ok((await page.screenshot()).length > 0);
      // ...and the page stays zoomed (Chromium resets it after a clipped
      // screenshot such as Playwright's; the server zooms it again).
      await page.waitForFunction(() => devicePixelRatio === 2);
      assert.equal(await page.evaluate(() => innerWidth), 500);
      await clickButton();
      assert.equal(await page.title(), "clicked 2");

      // Back to 100%; out of range zooms are clamped.
      await viewer.say({ type: "zoom", zoom: 1 });
      await page.waitForFunction(() => devicePixelRatio === 1);
      assert.equal(await page.evaluate(() => innerWidth), 1000);
      await viewer.say({ type: "zoom", zoom: 50 });
      await until(
        () => viewer.state?.zoom,
        (z) => z === 5,
        "clamped",
      );
    } finally {
      await agent.close().catch(() => {});
      await shared.close();
    }
  },
);

test(
  "take-over is fail closed: tunneled, cookie, DOM and script commands and tab HTTP endpoints wait while the human drives",
  {
    skip: executable ? false : "no Chrome/Chromium installed",
    timeout: 120_000,
  },
  async () => {
    const WebSocket = require("ws");
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
    // Chromium itself, to see what really happened.
    const direct = await CdpClient.connect(version.webSocketDebuggerUrl);
    const proxied = await (
      await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
    ).json();
    const ws = new WebSocket(proxied.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    const replies = new Map<number, any>();
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    });
    let nextId = 1;
    const send = (method: string, params: any = {}, sessionId?: string) => {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return id;
    };
    const reply = async (id: number, ms = 5000) => {
      const deadline = Date.now() + ms;
      while (!replies.has(id) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 25));
      return replies.get(id);
    };
    const title = async () => {
      const { targetInfos } = await direct.send("Target.getTargets");
      return targetInfos.find((t: any) => t.type === "page")?.title;
    };
    try {
      const page = (
        await reply(send("Target.getTargets"))
      ).result.targetInfos.find((t: any) => t.type === "page");
      const flat = (
        await reply(
          send("Target.attachToTarget", {
            targetId: page.targetId,
            flatten: true,
          }),
        )
      ).result.sessionId;
      await reply(
        send(
          "Runtime.evaluate",
          { expression: "document.title = 'before'" },
          flat,
        ),
      );
      server.setDriver("human");

      // Housekeeping still passes: a client keeps working.
      assert.ok(await reply(send("Target.getTargets")), "getTargets passes");
      const tunnel = (
        await reply(
          send("Target.attachToTarget", {
            targetId: page.targetId,
            flatten: false,
          }),
        )
      )?.result?.sessionId;
      assert.ok(tunnel, "attaching passes");

      // Everything that acts waits: no reply, and no effect.
      const held = [
        send("Target.sendMessageToTarget", {
          sessionId: tunnel,
          message: JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression: "document.title = 'tunneled'" },
          }),
        }),
        send("Storage.setCookies", {
          cookies: [
            { name: "planted", value: "1", domain: "example.com", path: "/" },
          ],
        }),
        send(
          "DOM.setAttributeValue",
          { nodeId: 1, name: "x", value: "y" },
          flat,
        ),
        send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: "document.title = 'injected'" },
          flat,
        ),
        send(
          "Runtime.evaluate",
          { expression: "document.title = 'direct'" },
          flat,
        ),
      ];
      await new Promise((r) => setTimeout(r, 1000));
      for (const id of held) assert.equal(replies.has(id), false, `held ${id}`);
      assert.equal(await title(), "before");
      const { cookies } = await direct.send("Storage.getCookies");
      assert.equal(
        cookies.some((c: any) => c.name === "planted"),
        false,
      );
      assert.equal(server.getState().agentWaiting, true);

      // The tab endpoints of the HTTP side are refused meanwhile.
      const opened = await fetch(
        `http://127.0.0.1:${cdpPort}/json/new?about:blank`,
        { method: "PUT" },
      );
      assert.equal(opened.status, 409);
      assert.equal(
        (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).status,
        200,
      );

      // Hand back: what waited is delivered, in order.
      server.setDriver("agent");
      for (const id of held) assert.ok(await reply(id), `delivered ${id}`);
      const deadline = Date.now() + 5000;
      while ((await title()) !== "direct" && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      assert.equal(await title(), "direct");
    } finally {
      ws.close();
      await server.close();
      await browser.stop();
      await profile.cleanup();
    }
  },
);

test(
  "a popup the human opens loads while they drive, with a Playwright agent connected",
  needsChrome,
  async () => {
    const { chromium } = require("playwright-core");
    const { createServer } = require("node:http");
    const site = createServer((req: any, res: any) => {
      res.setHeader("content-type", "text/html");
      res.end(
        req.url === "/popup"
          ? "<title>the popup</title>hi"
          : `<title>opener</title><a href="/popup" target=_blank style="font-size:60px">open</a>`,
      );
    });
    await new Promise<void>((resolve) =>
      site.listen(0, "127.0.0.1", () => resolve()),
    );
    const shared = await sharedBrowser();
    const direct = await CdpClient.connect(shared.version.webSocketDebuggerUrl);
    const agent = await chromium.connectOverCDP(
      `http://127.0.0.1:${shared.cdpPort}`,
    );
    try {
      const page = agent.contexts()[0].pages()[0];
      await page.goto(`http://127.0.0.1:${site.address().port}/`);
      const viewer = new TestViewer(shared.server);
      await viewer.resize(900, 560);
      await viewer.takeOver();
      await viewer.click(40, 30);
      // The popup starts and loads now, not after hand-back.
      const titles = await until(
        async () =>
          (await direct.send("Target.getTargets")).targetInfos
            .filter((t: any) => t.type === "page")
            .map((t: any) => t.title),
        (t: string[]) => t.includes("the popup"),
        "the popup loaded",
      );
      assert.ok(titles.includes("the popup"));
      assert.equal(shared.server.getState().driver, "human");
      // The viewer that opened it shows it, as a browser would.
      await until(
        () =>
          viewer.state?.tabs.find((t) => t.id === viewer.state?.active)?.title,
        (t) => t === "the popup",
        "the viewer shows the popup",
      );
      // The agent gets the popup too, once it has the browser back.
      const popup = agent
        .contexts()[0]
        .waitForEvent("page", { timeout: 10_000 })
        .catch(() => null);
      await viewer.handBack();
      const pages = agent
        .contexts()[0]
        .pages()
        .map((p: any) => p.url());
      assert.ok(
        (await popup) || pages.some((u: string) => u.includes("popup")),
      );
    } finally {
      direct.close();
      await agent.close().catch(() => {});
      await shared.close();
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
  "a file's browser is the human's first; waiting agents are shown; the last viewer leaving hands back",
  needsChrome,
  async () => {
    const shared = await sharedBrowser({
      humanFirst: true,
      handBackAfterMs: 300,
    });
    try {
      const viewer = new TestViewer(shared.server);
      await viewer.resize(800, 500);
      assert.equal(viewer.state?.driver, "human");

      // An agent action waits, and the human is told.
      const page = await SharedBrowserPage.open(
        `http://127.0.0.1:${shared.cdpPort}`,
      );
      const held = page.evaluate("1 + 1");
      await until(
        () => viewer.state?.agentWaiting,
        (w) => w === true,
        "the agent waits",
      );
      await viewer.handBack();
      assert.equal(await held, 2);
      assert.equal(viewer.state?.agentWaiting, false);

      // Input while the agent drives does nothing to the page.
      await page.goto("data:text/html,<title>t</title><input id=i autofocus>");
      await viewer.type("ignored");
      assert.equal(
        await page.evaluate("document.getElementById('i').value"),
        "",
      );

      // Closing the last viewer hands back, so agents never wait on nobody.
      await viewer.takeOver();
      viewer.close();
      await until(
        () => shared.server.getState().driver,
        (d) => d === "agent",
        "handed back",
        5000,
      );
      page.close();
    } finally {
      await shared.close();
    }
  },
);

test(
  "two viewers (split frames) show their own tabs of one browser",
  needsChrome,
  async () => {
    const shared = await sharedBrowser({ humanFirst: true });
    const active = (viewer: TestViewer) =>
      viewer.state?.tabs.find((t) => t.id === viewer.state?.active);
    const title = (viewer: TestViewer, title: string) =>
      until(
        () => active(viewer)?.title,
        (t) => t === title,
        `shows ${title}`,
      );
    try {
      const open = async (view: string, client = "me") => {
        const viewer = new TestViewer(shared.server, { view, client });
        await viewer.resize(700, 460);
        return viewer;
      };
      const a = await open("frame:a");
      await a.say({
        type: "navigate",
        url: "data:text/html,<title>one</title>A",
      });
      await title(a, "one");

      // A collaborator's view shares the tab: no new tab.
      const c = await open("frame:c", "someone-else");
      await title(c, "one");
      assert.equal(shared.server.getState().tabs.length, 1);

      // My split gets its own tab with the same page, right away.
      let b = await open("frame:b");
      await until(
        () => b.state?.tabs.length,
        (n) => n === 2,
        "a second tab",
      );
      await title(b, "one");
      await b.say({
        type: "navigate",
        url: "data:text/html,<title>two</title>B",
      });
      await title(b, "two");
      // A (and the collaborator) still show their tab, and all stream.
      assert.equal(active(a)?.title, "one");
      assert.equal(active(c)?.title, "one");
      await until(
        () => a.frames.length,
        (n) => n > 0,
        "A was streamed",
      );
      await until(
        () => b.frames.length,
        (n) => n > 0,
        "B was streamed",
      );

      // A frame that reloads comes back to its own tab, without a new one.
      b.close();
      b = await open("frame:b");
      await title(b, "two");
      assert.equal(shared.server.getState().tabs.length, 2);
      assert.equal(active(a)?.title, "one");

      // Agents act where the human last worked: B's tab.
      await b.handBack();
      const page = await SharedBrowserPage.open(
        `http://127.0.0.1:${shared.cdpPort}`,
        shared.server.getState().active,
      );
      assert.equal((await page.location()).title, "two");
      page.close();
    } finally {
      await shared.close();
    }
  },
);

test(
  "a hidden viewer keeps the page's size and gets no frames; shown again, it streams at once",
  needsChrome,
  async () => {
    const shared = await sharedBrowser();
    try {
      const viewer = new TestViewer(shared.server, {
        view: "frame:x",
        client: "me",
      });
      await viewer.resize(900, 560);
      const size = shared.server.getState().viewport;
      await until(
        () => viewer.frames.length,
        (n) => n > 0,
        "frames",
      );

      // Another tab or frame in front.
      await viewer.say({ type: "visible", visible: false });
      await sleep(300);
      const hidden = viewer.frames.length;
      const page = await SharedBrowserPage.open(
        `http://127.0.0.1:${shared.cdpPort}`,
      );
      await page.goto("data:text/html,<title>changed</title><h1>changed</h1>");
      await sleep(800);
      assert.equal(viewer.frames.length, hidden, "no frames while hidden");
      assert.deepEqual(shared.server.getState().viewport, size, "not shrunk");

      // Shown again: the current picture right away.
      await viewer.say({ type: "visible", visible: true });
      await until(
        () => viewer.frames.length,
        (n) => n > hidden,
        "frames again",
      );
      assert.deepEqual(shared.server.getState().viewport, size);

      // Resizing the viewer resizes the page.
      await viewer.resize(700, 500);
      assert.equal(
        await page.evaluate("innerWidth"),
        700,
        "the page follows the viewer's size",
      );
      page.close();
    } finally {
      await shared.close();
    }
  },
);

test(
  "a still page gets one lossless frame at the stream's size, then nothing",
  needsChrome,
  async () => {
    const shared = await sharedBrowser();
    try {
      const page = await SharedBrowserPage.open(
        `http://127.0.0.1:${shared.cdpPort}`,
      );
      await page.goto("data:text/html,<title>t</title><h1>Sharp text</h1>");
      page.close();
      const viewer = new TestViewer(shared.server);
      await viewer.resize(800, 500, "sharp");
      const sizes = () => viewer.frames.map(imageSize);
      // At rest: a lossless frame, at the stream's (the page's) size...
      await until(
        sizes,
        (f) => f.some((x) => x.type === "png" && x.width === 800),
        "a lossless frame",
      );
      // ...and then nothing more while nothing changes (no capture loop).
      await sleep(1000);
      const settled = viewer.frames.length;
      await sleep(2000);
      assert.equal(viewer.frames.length, settled, "no frames at rest");
      assert.equal(sizes().at(-1)?.type, "png", "the lossless frame stays");

      // Fast: stream frames only.
      await viewer.resize(800, 500, "fast");
      await sleep(500);
      viewer.frames = [];
      const p2 = await SharedBrowserPage.open(
        `http://127.0.0.1:${shared.cdpPort}`,
      );
      await p2.evaluate("document.body.style.background = 'yellow'");
      p2.close();
      await until(
        () => viewer.frames.length,
        (n) => n > 0,
        "stream frames",
      );
      await sleep(1500);
      assert.ok(!sizes().some((x) => x.type === "png"));
    } finally {
      await shared.close();
    }
  },
);

test(
  "clicks land where the human clicks, also on a page wider than the headless window",
  needsChrome,
  async () => {
    const shared = await sharedBrowser();
    try {
      const page = await SharedBrowserPage.open(
        `http://127.0.0.1:${shared.cdpPort}`,
      );
      await page.goto(
        "data:text/html,<body style='margin:0'><script>addEventListener('mousedown',e=>document.title=e.clientX+','+e.clientY+','+innerWidth)</script></body>",
      );
      page.close();
      // Wider than the headless window (1280): clicks far right matter.
      const viewer = new TestViewer(shared.server, { view: "frame:wide" });
      await viewer.resize(1500, 700);
      await viewer.takeOver();
      await sleep(500);
      await viewer.click(1000, 100);
      await sleep(500);
      await viewer.handBack();
      const p = await SharedBrowserPage.open(
        `http://127.0.0.1:${shared.cdpPort}`,
        shared.server.getState().active,
      );
      const [x, y, width] = (await p.location()).title.split(",").map(Number);
      p.close();
      assert.deepEqual([x, y, width], [1000, 100, 1500]);
    } finally {
      await shared.close();
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
  needsChrome,
  async () => {
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
    const { cdpPort } = await server.start();
    // The "computer": its own Chrome.
    const profile = await createProfileDir("disk", sys);
    const laptop = await launchBrowser({
      executable: executable!,
      profileDir: profile.path,
      args: sharedBrowserChromeArgs(profile.path),
    });
    let tunnel: Awaited<ReturnType<typeof tcpForward>> | null = null;
    try {
      // Waiting: the viewer is told how to connect; agents get a clear error.
      // The viewer says which site the user is on.
      const viewer = new TestViewer(server, {
        view: "frame:w",
        client: "me",
        site: "https://example.cocalc.ai",
      });
      assert.equal(viewer.state?.connection, "waiting");
      assert.match(
        viewer.state?.connectCommand ?? "",
        /connect -w p --browser \/home\/user\/t\.browser --api https:\/\/example\.cocalc\.ai$/,
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
      await until(
        () => viewer.state?.connection,
        (c) => c === "connected",
        "attached",
      );
      // A preview streams.
      await viewer.say({ type: "visible", visible: true });
      await until(
        () => viewer.frames.length,
        (n) => n > 0,
        "a preview",
      );
      // Agents reach it through our endpoint (addresses rewritten).
      const page = await SharedBrowserPage.open(
        `http://127.0.0.1:${cdpPort}`,
        server.getState().active,
      );
      await viewer.handBack();
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
      // And no page input from the viewer: the human uses that window.
      await viewer.takeOver();
      await viewer.say({
        type: "navigate",
        url: "data:text/html,<title>no</title>",
      });
      await sleep(300);
      // (The agent's own commands wait while the human drives.)
      await viewer.handBack();
      assert.equal((await page.location()).title, "on the laptop");
      page.close();

      // The tunnel drops: back to waiting, nothing hangs.
      await tunnel.close();
      tunnel = null;
      await until(
        () => viewer.state?.connection,
        (c) => c === "waiting",
        "waiting again",
      );

      // The viewer's switch asks to run it in the project instead.
      await viewer.say({ type: "runsOn", value: "project" });
      await until(
        () => switched,
        (s) => s.length > 0,
        "switched",
      );
      assert.deepEqual(switched, ["project"]);
    } finally {
      await tunnel?.close();
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
        env: {
          ...withoutCoCalcCredentials(),
          HOME: home,
          COCALC_CHROME: executable,
        },
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
  needsChrome,
  async () => {
    const shared = await sharedBrowser();
    try {
      const page = await SharedBrowserPage.open(
        `http://127.0.0.1:${shared.cdpPort}`,
      );
      await page.goto(
        "data:text/html,<body style='margin:0'>" +
          "<p>line</p>".repeat(300) +
          "</body>",
      );
      page.close();
      const viewer = new TestViewer(shared.server);
      await viewer.resize(900, 560, "sharp");
      await viewer.takeOver();
      for (let i = 0; i < 5; i++) {
        await viewer.say({
          type: "mouse",
          event: "mouseWheel",
          x: 200,
          y: 200,
          deltaX: 0,
          deltaY: 300,
        });
        await sleep(100);
      }
      // Let it settle, then nothing more should arrive.
      await sleep(2500);
      const settled = viewer.frames.length;
      await sleep(3000);
      const sizes = viewer.frames.map(imageSize);
      assert.equal(sizes.length, settled, "no frames at rest");
      // The still frame has the stream's proportions (no grey strip).
      const last = sizes.at(-1)!;
      const stream = sizes.find((f) => f.type === "jpeg") ?? last;
      assert.ok(
        Math.abs(last.width / last.height - stream.width / stream.height) <
          0.01,
        `still ${JSON.stringify(last)} vs stream ${JSON.stringify(stream)}`,
      );
    } finally {
      await shared.close();
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
    const {
      existsSync,
      mkdirSync,
      mkdtempSync,
      rmSync,
      writeFileSync,
    } = require("node:fs");
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
            ...withoutCoCalcCredentials(),
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
    const until = async (
      ok: () => Promise<boolean> | boolean,
      what: string,
    ) => {
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

test("nothing outside the project reaches the CLI's API or agents' CDP: proxied requests and web pages are refused", async () => {
  const WebSocket = require("ws");
  const server = new SharedBrowserServer({
    host: "127.0.0.1",
    port: 0,
    cdpPort: 0,
  });
  const { port, cdpPort } = await server.start();
  try {
    const api = `http://127.0.0.1:${port}`;
    const cdp = `http://127.0.0.1:${cdpPort}`;
    // The CLI in the project.
    assert.equal((await fetch(`${api}/api/state`)).status, 200);
    // Through CoCalc's proxy (it adds X-Forwarded-For), or from a web page.
    for (const headers of <Record<string, string>[]>[
      { "x-forwarded-for": "203.0.113.5" },
      { origin: "https://evil.example" },
    ]) {
      assert.equal((await fetch(`${api}/api/state`, { headers })).status, 403);
      assert.equal(
        (
          await fetch(`${api}/api/driver`, {
            method: "POST",
            headers,
            body: JSON.stringify({ driver: "human" }),
          })
        ).status,
        403,
      );
      assert.equal(
        (await fetch(`${cdp}/json/version`, { headers })).status,
        403,
      );
    }
    assert.equal(server.getState().driver, "agent");
    // No viewer page, and no viewer socket, over HTTP any more.
    assert.equal((await fetch(`${api}/`)).status, 404);
    assert.equal((await fetch(`${api}/api/start`)).status, 404);
    assert.equal((await fetch(`${api}/favicon?url=x`)).status, 404);
    const refused = (url: string, options: any = {}) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(url, options);
        ws.once("open", () => {
          ws.close();
          resolve(false);
        });
        ws.once("error", () => resolve(true));
      });
    assert.equal(await refused(`ws://127.0.0.1:${port}/viewer`), true);
    // CDP over a WebSocket from a web page (it sends its Origin).
    assert.equal(
      await refused(`ws://127.0.0.1:${cdpPort}/devtools/browser/x`, {
        origin: "https://evil.example",
      }),
      true,
    );
  } finally {
    await server.close();
  }
});

test("viewers over conat: hello, state, frames with acknowledgements, requests, goodbye", async () => {
  const { init: createConatServer } = require("@cocalc/conat/core/server");
  const getPort = require("@cocalc/backend/get-port").default;
  const { once } = require("node:events");
  const { serveViewers } = require("./viewer-socket");
  const {
    FRAME_HEADER,
    FRAMES_IN_FLIGHT,
    sharedBrowserSubject,
  } = require("@cocalc/util/shared-browser-protocol");
  const conat = createConatServer({ port: await getPort(), path: "/conat" });
  if (conat.state !== "ready") await once(conat, "ready");
  const projectClient = conat.client({ noCache: true, path: "/" });
  const userClient = conat.client({ noCache: true, path: "/" });
  // The browser service, as far as viewers see it.
  const events: string[] = [];
  let channel: ViewerChannel | null = null;
  const fake: any = {
    addViewer: (c: ViewerChannel, hello: any) => {
      channel = c;
      events.push(`hello ${hello.view}`);
      c.send({ type: "state", state: { driver: "agent" } as any });
    },
    viewerMessage: async (_c: ViewerChannel, msg: any) => {
      events.push(msg.type);
    },
    viewerRequest: async (_c: ViewerChannel, request: any) => {
      if (request.type === "start") return { servers: [], recent: [] };
      throw Error("unknown request");
    },
    removeViewer: () => events.push("bye"),
  };
  const project_id = "00000000-1000-4000-8000-000000000000";
  const viewers = serveViewers({
    client: projectClient,
    server: fake,
    projectId: project_id,
    appId: "cocalc-browser",
  });
  const socket = userClient.socket.connect(
    sharedBrowserSubject(project_id, "cocalc-browser"),
  );
  try {
    const received: { data: any; seq?: number }[] = [];
    socket.on("data", (data: any, headers: any) =>
      received.push({ data, seq: headers?.[FRAME_HEADER] }),
    );
    await socket.waitUntilReady(10_000);
    // Nothing counts before hello.
    socket.write({ type: "takeover" });
    socket.write({ type: "hello", view: "card:1" });
    socket.write({ type: "takeover" });
    await until(
      () => events,
      (e) => e.includes("takeover"),
      "the message",
    );
    assert.deepEqual(events, ["hello card:1", "takeover"]);
    await until(
      () => received,
      (r) => r.some((m) => m.data?.type === "state"),
      "the state",
    );

    // Frames: a few in flight, then the newest waits for an acknowledgement.
    for (let i = 1; i <= 10; i++) channel!.sendFrame(Buffer.from([i]));
    const frames = () => received.filter((m) => m.seq != null);
    await until(frames, (f) => f.length === FRAMES_IN_FLIGHT, "frames");
    await sleep(300);
    assert.equal(frames().length, FRAMES_IN_FLIGHT);
    assert.deepEqual(
      frames().map((f) => [...new Uint8Array(f.data)][0]),
      [1, 2, 3],
    );
    socket.write({ type: "ack", seq: frames()[0].seq });
    await until(frames, (f) => f.length === FRAMES_IN_FLIGHT + 1, "the newest");
    assert.equal([...new Uint8Array(frames().at(-1)!.data)][0], 10);
    assert.equal(events.includes("ack"), false, "acks stay in the transport");

    // Requests.
    assert.deepEqual((await socket.request({ type: "start" })).data, {
      servers: [],
      recent: [],
    });
    await assert.rejects(socket.request({ type: "nope" }), /unknown request/);

    socket.close();
    await until(
      () => events,
      (e) => e.includes("bye"),
      "goodbye",
    );
  } finally {
    socket.close();
    viewers.close();
    projectClient.close();
    userClient.close();
    await conat.close();
  }
});
