/**
 * Shared browser: one headless Chromium in the project that an agent drives
 * over the Chrome DevTools Protocol (CDP) and a human watches and uses
 * through a viewer page (embedded in a chat card via the project app proxy).
 *
 * Two listeners:
 * - the app port (behind CoCalc's authenticated app proxy): the viewer page,
 *   its WebSocket (screencast frames, state, human input), and a small JSON
 *   API used by the CLI;
 * - a loopback CDP port for agents, proxied to Chromium.  While the human has
 *   taken over, agent commands are held and delivered on hand-back.
 *
 * Headless Chromium draws neither native <select> popups nor dialogs into
 * the screencast; those are reported to the viewer, which draws them.
 */
import http from "node:http";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

import { CdpClient, type CdpEvent } from "./cdp-client";
import {
  pickSelectExpression,
  SELECT_BINDING,
  selectScript,
} from "./page-script";
import { VIEWER_HTML } from "./viewer-html";

export type Driver = "agent" | "human";

export interface SharedBrowserTab {
  id: string;
  url: string;
  title: string;
}

export interface SharedBrowserState {
  driver: Driver;
  // The agent asked the human to take over (e.g. to log in).
  ask: { message: string; at: string } | null;
  tabs: SharedBrowserTab[];
  active: string | null;
  viewport: { width: number; height: number };
  dialog: { type: string; message: string; defaultPrompt?: string } | null;
  select: {
    options: { label: string; disabled?: boolean; group?: string }[];
    selected: number;
  } | null;
  fileChooser: { mode: string } | null;
  agents: number;
  cdp: string;
  viewers: number;
}

export interface SharedBrowserServerOptions {
  /** Chromium's own browser-level DevTools URL (ws://127.0.0.1:N/devtools/browser/ID). */
  chromeWebSocketUrl: string;
  host: string;
  port: number;
  cdpPort: number;
  log?: (message: string) => void;
}

const MAX_VIEWPORT = 3840;

// Agent commands that act on the page.  While the human drives, these wait
// for hand-back; everything else (protocol housekeeping such as enabling
// domains or letting a new popup start) passes, so the agent's client keeps
// working and pages opened by the human do not stall.
export const HELD_WHILE_HUMAN_DRIVES =
  /^(Input\.|Page\.(navigate|reload|navigateToHistoryEntry|stopLoading|handleJavaScriptDialog|bringToFront|close)$|Target\.(createTarget|closeTarget|activateTarget)$|Runtime\.(evaluate|callFunctionOn)$|DOM\.setFileInputFiles$)/;

export class SharedBrowserServer {
  private cdp!: CdpClient;
  private chromeHttp: string;
  private appServer!: http.Server;
  private cdpServer!: http.Server;
  private viewers = new Set<WebSocket>();
  private agentSockets = new Set<WebSocket>();
  private held: Array<() => void> = [];
  private state: SharedBrowserState;
  // Our own flat session on the active tab (screencast, input, overlays).
  private session: string | null = null;
  private sessionTarget: string | null = null;
  private casting = false;
  private fileChooserNode: number | null = null;
  private selectContext: number | null = null;
  private scriptIds = new Map<string, string>();
  private switching: Promise<void> = Promise.resolve();
  private log: (message: string) => void;

  constructor(private readonly options: SharedBrowserServerOptions) {
    this.log = options.log ?? (() => {});
    const url = new URL(options.chromeWebSocketUrl);
    this.chromeHttp = `http://${url.host}`;
    this.state = {
      driver: "agent",
      ask: null,
      tabs: [],
      active: null,
      viewport: { width: 1280, height: 800 },
      dialog: null,
      select: null,
      fileChooser: null,
      agents: 0,
      cdp: "",
      viewers: 0,
    };
  }

  getState(): SharedBrowserState {
    return structuredClone(this.state);
  }

  async start(): Promise<{ port: number; cdpPort: number }> {
    this.cdp = await CdpClient.connect(this.options.chromeWebSocketUrl);
    this.cdp.on((event) => this.onCdpEvent(event));
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    for (const info of targetInfos) this.addTab(info);
    if (this.state.tabs.length === 0) {
      await this.cdp.send("Target.createTarget", { url: "about:blank" });
    } else {
      await this.activate(this.state.tabs[this.state.tabs.length - 1].id);
    }

    this.appServer = http.createServer((req, res) =>
      this.onAppRequest(req, res),
    );
    const viewerWss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });
    this.appServer.on("upgrade", (req, socket, head) => {
      if (!new URL(req.url ?? "/", "http://x").pathname.endsWith("/viewer")) {
        socket.destroy();
        return;
      }
      viewerWss.handleUpgrade(req, socket, head, (ws) => this.addViewer(ws));
    });
    const port = await listen(
      this.appServer,
      this.options.host,
      this.options.port,
    );

    this.cdpServer = http.createServer((req, res) => this.onCdpHttp(req, res));
    const agentWss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 0,
    });
    this.cdpServer.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (!path.startsWith("/devtools/")) {
        socket.destroy();
        return;
      }
      agentWss.handleUpgrade(req, socket, head, (ws) =>
        this.addAgent(ws, path),
      );
    });
    const cdpPort = await listenPreferring(
      this.cdpServer,
      "127.0.0.1",
      this.options.cdpPort,
    );
    this.state.cdp = `http://127.0.0.1:${cdpPort}`;
    this.log(
      `viewer on ${this.options.host}:${port}, agent CDP on ${this.state.cdp}`,
    );
    return { port, cdpPort };
  }

  async close(): Promise<void> {
    for (const ws of [...this.viewers, ...this.agentSockets]) ws.terminate();
    await Promise.all([
      closeServer(this.appServer),
      closeServer(this.cdpServer),
    ]);
    this.cdp?.close();
  }

  // --- driver ------------------------------------------------------------

  setDriver(driver: Driver): void {
    if (this.state.driver === driver) return;
    this.state.driver = driver;
    if (driver === "agent") {
      this.state.ask = null;
      this.state.select = null;
      this.state.fileChooser = null;
      const held = this.held;
      this.held = [];
      for (const deliver of held) deliver();
    }
    void this.applyDriverToPage();
    this.broadcastState();
  }

  ask(message: string): void {
    this.state.ask = {
      message: message.slice(0, 2000),
      at: new Date().toISOString(),
    };
    this.broadcastState();
  }

  private async applyDriverToPage(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const human = this.state.driver === "human";
    // While the human drives, our session handles the file chooser; while
    // the agent drives, its own client may want to.
    await this.cdp
      .send("Page.setInterceptFileChooserDialog", { enabled: human }, session)
      .catch(() => {});
    await this.installSelectScript(session, human).catch(() => {});
  }

  private async installSelectScript(session: string, human: boolean) {
    const old = this.scriptIds.get(session);
    if (old)
      await this.cdp
        .send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: old },
          session,
        )
        .catch(() => {});
    const source = selectScript(human);
    const { identifier } = await this.cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
      session,
    );
    this.scriptIds.set(session, identifier);
    await this.cdp
      .send("Runtime.evaluate", { expression: source }, session)
      .catch(() => {});
  }

  // --- tabs and our page session -----------------------------------------

  private addTab(info: any): void {
    if (info.type !== "page") return;
    if (this.state.tabs.some((tab) => tab.id === info.targetId)) return;
    this.state.tabs.push({
      id: info.targetId,
      url: info.url ?? "",
      title: info.title ?? "",
    });
  }

  activate(targetId: string): Promise<void> {
    // Serialize switches; the latest request wins.
    this.switching = this.switching
      .then(() => this.switchTo(targetId))
      .catch((err) => this.log(`switch tab: ${err?.message ?? err}`));
    return this.switching;
  }

  private async switchTo(targetId: string): Promise<void> {
    if (this.sessionTarget === targetId) return;
    if (!this.state.tabs.some((tab) => tab.id === targetId)) return;
    const old = this.session;
    this.session = null;
    this.sessionTarget = null;
    this.casting = false;
    if (old)
      await this.cdp
        .send("Target.detachFromTarget", { sessionId: old })
        .catch(() => {});
    const { sessionId } = await this.cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.session = sessionId;
    this.sessionTarget = targetId;
    this.state.active = targetId;
    this.state.dialog = null;
    this.state.select = null;
    this.state.fileChooser = null;
    await this.cdp.send("Page.enable", {}, sessionId);
    await this.cdp.send("Runtime.enable", {}, sessionId);
    await this.cdp.send(
      "Runtime.addBinding",
      { name: SELECT_BINDING },
      sessionId,
    );
    await this.cdp.send(
      "Emulation.setFocusEmulationEnabled",
      { enabled: true },
      sessionId,
    );
    await this.applyViewport();
    await this.applyDriverToPage();
    await this.updateCasting();
    this.broadcastState();
  }

  private async applyViewport(): Promise<void> {
    if (!this.session) return;
    const { width, height } = this.state.viewport;
    await this.cdp
      .send(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 1, mobile: false },
        this.session,
      )
      .catch(() => {});
    if (this.casting) {
      await this.cdp
        .send("Page.stopScreencast", {}, this.session)
        .catch(() => {});
      this.casting = false;
      await this.updateCasting();
    }
  }

  // Only stream while someone is watching.
  private async updateCasting(): Promise<void> {
    if (!this.session) return;
    const want = this.viewers.size > 0;
    if (want === this.casting) return;
    this.casting = want;
    if (want) {
      const { width, height } = this.state.viewport;
      await this.cdp.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 70, maxWidth: width, maxHeight: height },
        this.session,
      );
    } else {
      await this.cdp
        .send("Page.stopScreencast", {}, this.session)
        .catch(() => {});
    }
  }

  private onCdpEvent(event: CdpEvent): void {
    const { method, params, sessionId } = event;
    if (method === "Target.targetCreated") {
      const before = this.state.tabs.length;
      this.addTab(params.targetInfo);
      if (this.state.tabs.length > before) {
        // New tabs and popups come to the front, as in a normal browser.
        void this.activate(params.targetInfo.targetId);
        this.broadcastState();
      }
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const tab = this.state.tabs.find(
        (t) => t.id === params.targetInfo.targetId,
      );
      if (tab) {
        tab.url = params.targetInfo.url ?? tab.url;
        tab.title = params.targetInfo.title ?? tab.title;
        this.broadcastState();
      }
      return;
    }
    if (method === "Target.targetDestroyed") {
      const index = this.state.tabs.findIndex((t) => t.id === params.targetId);
      if (index < 0) return;
      this.state.tabs.splice(index, 1);
      if (this.sessionTarget === params.targetId) {
        this.session = null;
        this.sessionTarget = null;
        this.casting = false;
        const next =
          this.state.tabs[Math.min(index, this.state.tabs.length - 1)];
        this.state.active = next?.id ?? null;
        if (next) void this.activate(next.id);
        else
          void this.cdp
            .send("Target.createTarget", { url: "about:blank" })
            .catch(() => {});
      }
      this.broadcastState();
      return;
    }
    if (!sessionId || sessionId !== this.session) return;
    if (method === "Page.screencastFrame") {
      this.cdp.notify(
        "Page.screencastFrameAck",
        { sessionId: params.sessionId },
        sessionId,
      );
      const frame = Buffer.from(params.data, "base64");
      for (const ws of this.viewers) {
        // Drop frames for slow viewers instead of queueing them.
        if (ws.bufferedAmount < 2 * 1024 * 1024)
          ws.send(frame, { binary: true });
      }
      return;
    }
    if (method === "Page.javascriptDialogOpening") {
      this.state.dialog = {
        type: params.type,
        message: params.message ?? "",
        defaultPrompt: params.defaultPrompt,
      };
      this.broadcastState();
      return;
    }
    if (method === "Page.javascriptDialogClosed") {
      this.state.dialog = null;
      this.broadcastState();
      return;
    }
    if (method === "Page.fileChooserOpened") {
      this.fileChooserNode = params.backendNodeId ?? null;
      this.state.fileChooser = { mode: params.mode };
      this.broadcastState();
      return;
    }
    if (method === "Runtime.bindingCalled" && params.name === SELECT_BINDING) {
      try {
        const payload = JSON.parse(params.payload);
        this.selectContext = params.executionContextId;
        this.state.select = {
          options: (payload.options ?? []).slice(0, 2000),
          selected: payload.selected ?? -1,
        };
        this.broadcastState();
      } catch {
        // ignore malformed payloads from the page
      }
    }
  }

  // --- viewers -------------------------------------------------------------

  private addViewer(ws: WebSocket): void {
    this.viewers.add(ws);
    this.state.viewers = this.viewers.size;
    ws.send(JSON.stringify({ type: "state", state: this.state }));
    void this.updateCasting();
    this.broadcastState();
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onViewerMessage(msg).catch((err) =>
        ws.send(
          JSON.stringify({ type: "error", message: `${err?.message ?? err}` }),
        ),
      );
    });
    ws.on("close", () => {
      this.viewers.delete(ws);
      this.state.viewers = this.viewers.size;
      void this.updateCasting();
      this.broadcastState();
    });
  }

  private broadcastState(): void {
    const text = JSON.stringify({ type: "state", state: this.state });
    for (const ws of this.viewers) ws.send(text);
  }

  private async onViewerMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case "takeover":
        return this.setDriver("human");
      case "handback":
        return this.setDriver("agent");
      case "resize": {
        const width = clampInt(msg.width, 200, MAX_VIEWPORT);
        const height = clampInt(msg.height, 150, MAX_VIEWPORT);
        if (
          width === this.state.viewport.width &&
          height === this.state.viewport.height
        )
          return;
        this.state.viewport = { width, height };
        await this.applyViewport();
        this.broadcastState();
        return;
      }
      case "tab":
        if (typeof msg.id === "string") await this.activate(msg.id);
        return;
    }
    // Everything below acts on the page: only while the human drives.
    if (this.state.driver !== "human") return;
    const s = this.session;
    if (!s) return;
    switch (msg.type) {
      case "mouse":
        // Not awaited: a click that opens alert() is only acknowledged once
        // the dialog is answered.
        void this.cdp
          .send(
            "Input.dispatchMouseEvent",
            {
              type: msg.event,
              x: num(msg.x),
              y: num(msg.y),
              button: msg.button ?? "none",
              buttons: msg.buttons,
              clickCount: msg.clickCount ?? 0,
              deltaX: num(msg.deltaX),
              deltaY: num(msg.deltaY),
              modifiers: msg.modifiers ?? 0,
            },
            s,
          )
          .catch(() => {});
        return;
      case "key":
        void this.cdp
          .send(
            "Input.dispatchKeyEvent",
            {
              type: msg.event,
              key: msg.key,
              code: msg.code,
              text: msg.text,
              unmodifiedText: msg.text,
              windowsVirtualKeyCode: msg.keyCode,
              nativeVirtualKeyCode: msg.keyCode,
              modifiers: msg.modifiers ?? 0,
            },
            s,
          )
          .catch(() => {});
        return;
      case "text":
        if (typeof msg.text === "string" && msg.text)
          void this.cdp
            .send("Input.insertText", { text: msg.text.slice(0, 100_000) }, s)
            .catch(() => {});
        return;
      case "navigate": {
        const url = normalizeUrl(`${msg.url ?? ""}`);
        if (url) await this.cdp.send("Page.navigate", { url }, s);
        return;
      }
      case "history": {
        const { currentIndex, entries } = await this.cdp.send(
          "Page.getNavigationHistory",
          {},
          s,
        );
        const entry = entries[currentIndex + (msg.delta === -1 ? -1 : 1)];
        if (entry)
          await this.cdp.send(
            "Page.navigateToHistoryEntry",
            { entryId: entry.id },
            s,
          );
        return;
      }
      case "reload":
        await this.cdp.send("Page.reload", {}, s);
        return;
      case "newTab":
        await this.cdp.send("Target.createTarget", { url: "about:blank" });
        return;
      case "closeTab":
        if (typeof msg.id === "string")
          await this.cdp.send("Target.closeTarget", { targetId: msg.id });
        return;
      case "dialog":
        await this.cdp.send(
          "Page.handleJavaScriptDialog",
          {
            accept: !!msg.accept,
            promptText:
              typeof msg.promptText === "string" ? msg.promptText : undefined,
          },
          s,
        );
        return;
      case "select": {
        this.state.select = null;
        this.broadcastState();
        if (
          Number.isInteger(msg.index) &&
          msg.index >= 0 &&
          this.selectContext != null
        )
          await this.cdp.send(
            "Runtime.evaluate",
            {
              expression: pickSelectExpression(msg.index),
              contextId: this.selectContext,
            },
            s,
          );
        return;
      }
      case "file": {
        const node = this.fileChooserNode;
        this.state.fileChooser = null;
        this.fileChooserNode = null;
        this.broadcastState();
        const files = (Array.isArray(msg.paths) ? msg.paths : [])
          .map((p: unknown) => resolveProjectFile(`${p}`))
          .filter((p: string | null): p is string => !!p);
        if (node != null && files.length)
          await this.cdp.send(
            "DOM.setFileInputFiles",
            { files, backendNodeId: node },
            s,
          );
        return;
      }
    }
  }

  // --- app HTTP: viewer page and API ----------------------------------------

  private onAppRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (
      req.method === "GET" &&
      (path === "/" || path.endsWith("/index.html"))
    ) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(VIEWER_HTML);
      return;
    }
    if (path.endsWith("/api/state") && req.method === "GET") {
      return json(res, 200, this.state);
    }
    if (
      req.method === "POST" &&
      (path.endsWith("/api/ask") || path.endsWith("/api/driver"))
    ) {
      readJson(req)
        .then((body) => {
          if (path.endsWith("/api/ask")) this.ask(`${body?.message ?? ""}`);
          else if (body?.driver === "human" || body?.driver === "agent")
            this.setDriver(body.driver);
          json(res, 200, this.state);
        })
        .catch((err) => json(res, 400, { error: `${err?.message ?? err}` }));
      return;
    }
    if (path === "/healthz" || path.endsWith("/healthz"))
      return json(res, 200, { ok: true });
    json(res, 404, { error: "not found" });
  }

  // --- agent CDP proxy ------------------------------------------------------

  private async onCdpHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/json"))
      return json(res, 404, { error: "not found" });
    try {
      const upstream = await fetch(
        `${this.chromeHttp}${url.pathname}${url.search}`,
        {
          method: req.method === "PUT" ? "PUT" : "GET",
        },
      );
      const text = await upstream.text();
      const chromeHost = new URL(this.chromeHttp).host;
      const ours = `127.0.0.1:${(this.cdpServer.address() as any).port}`;
      res.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(text.split(chromeHost).join(ours));
    } catch (err: any) {
      json(res, 502, { error: `${err?.message ?? err}` });
    }
  }

  private addAgent(client: WebSocket, path: string): void {
    const upstream = new WebSocket(
      `ws://${new URL(this.chromeHttp).host}${path}`,
      {
        perMessageDeflate: false,
        maxPayload: 0,
      },
    );
    const pending: Array<WebSocket.RawData> = [];
    let open = false;
    this.agentSockets.add(client);
    this.state.agents = this.agentSockets.size;
    this.broadcastState();
    const deliver = (data: WebSocket.RawData) => {
      if (upstream.readyState !== WebSocket.OPEN) return;
      const text = data.toString();
      const msg = parseMessage(text);
      // A dialog answer held while the human drove may refer to a dialog the
      // human already answered; Chromium would reply with an error that some
      // clients (Playwright's auto-dismiss) do not handle.
      if (
        msg?.method === "Page.handleJavaScriptDialog" &&
        this.state.dialog == null
      ) {
        if (client.readyState === WebSocket.OPEN)
          client.send(
            JSON.stringify({
              id: msg.id,
              sessionId: msg.sessionId,
              result: {},
            }),
          );
        return;
      }
      this.followAgent(msg);
      upstream.send(text);
    };
    upstream.on("open", () => {
      open = true;
      for (const data of pending.splice(0)) this.forwardAgent(data, deliver);
    });
    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data.toString());
    });
    client.on("message", (data) => {
      if (!open) pending.push(data);
      else this.forwardAgent(data, deliver);
    });
    const end = () => {
      if (!this.agentSockets.delete(client)) return;
      this.state.agents = this.agentSockets.size;
      this.broadcastState();
      client.close();
      upstream.close();
    };
    client.on("close", end);
    client.on("error", end);
    upstream.on("close", end);
    upstream.on("error", end);
  }

  // While the human drives, agent commands that act on the page wait, in
  // order, for hand-back.
  private forwardAgent(
    data: WebSocket.RawData,
    deliver: (d: WebSocket.RawData) => void,
  ): void {
    const method = parseMessage(data.toString())?.method;
    if (
      this.state.driver === "human" &&
      typeof method === "string" &&
      HELD_WHILE_HUMAN_DRIVES.test(method)
    )
      this.held.push(() => deliver(data));
    else deliver(data);
  }

  // Show the tab the agent brings to the front.
  private followAgent(msg: any): void {
    if (
      msg?.method === "Target.activateTarget" &&
      typeof msg.params?.targetId === "string"
    )
      void this.activate(msg.params.targetId);
  }
}

function parseMessage(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function listen(
  server: http.Server,
  host: string,
  port: number,
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePort((server.address() as any).port);
    });
  });
}

// The conventional DevTools port when free, otherwise the next free one.
async function listenPreferring(
  server: http.Server,
  host: string,
  port: number,
): Promise<number> {
  for (let candidate = port; candidate < port + 20; candidate++) {
    try {
      return await listen(server, host, candidate);
    } catch (err: any) {
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }
  return await listen(server, host, 0);
}

function closeServer(server?: http.Server): Promise<void> {
  return new Promise((done) => (server ? server.close(() => done()) : done()));
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((done, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error("request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        done(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampInt(value: unknown, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(num(value)) || min));
}

export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^(https?|about|data):/i.test(text)) return text;
  // Local addresses, possibly with a port (checked before the scheme rule,
  // since "localhost:8080" looks like a scheme).
  if (/^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?(\/|$)/i.test(text))
    return `http://${text}`;
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(text) &&
    !/^[^\s/:]+\.[^\s/:]+:\d+/.test(text)
  )
    return null; // e.g. file:, javascript:
  if (/^[^\s/]+\.[^\s/]+/.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

// Files offered to a page's file chooser come from the project, relative to
// the home directory.
export function resolveProjectFile(path: string): string | null {
  const home = homedir();
  const full = isAbsolute(path) ? path : resolve(home, path);
  try {
    return existsSync(full) && statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}
