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
  // Agent commands are waiting for the human to hand back.
  agentWaiting: boolean;
  cdp: string;
  viewers: number;
}

// The screencast streams changes as JPEG at CSS pixels (headless Chromium
// does not scale it); once the page is still, one frame at the viewer's
// device pixels replaces it: lossless PNG (sharp) or high-quality JPEG
// (balanced).  Fast skips that (slow links).
export type ViewQuality = "sharp" | "balanced" | "fast";
const QUALITY: Record<
  ViewQuality,
  {
    jpeg: number;
    maxScale: number;
    rest: null | { format: string; quality?: number };
  }
> = {
  sharp: { jpeg: 80, maxScale: 2, rest: { format: "png" } },
  balanced: { jpeg: 75, maxScale: 2, rest: { format: "jpeg", quality: 92 } },
  fast: { jpeg: 60, maxScale: 1, rest: null },
};
// A lossless frame this long after the last change, in sharp mode.
const SETTLE_MS = 350;

interface TabPage {
  targetId: string;
  // Device pixels per CSS pixel the viewer draws at, and its quality.
  scale: number;
  quality: ViewQuality;
  settleTimer: NodeJS.Timeout | null;
  // The last screencast frame, to recognize frames without a change.
  lastFrame: Buffer | null;
  session: string | null;
  ready: Promise<void> | null;
  casting: boolean;
  viewport: { width: number; height: number };
  dialog: SharedBrowserState["dialog"];
  select: SharedBrowserState["select"];
  fileChooser: SharedBrowserState["fileChooser"];
  fileChooserNode: number | null;
  selectContext: number | null;
  scriptId: string | null;
}

export interface SharedBrowserServerOptions {
  /** Chromium's own browser-level DevTools URL (ws://127.0.0.1:N/devtools/browser/ID). */
  chromeWebSocketUrl: string;
  host: string;
  port: number;
  cdpPort: number;
  // A .browser file's browser is the human's: whoever opens it drives,
  // unless an agent is using it.
  humanFirst?: boolean;
  // Hand back to the agent this long after the last viewer leaves while the
  // human drives, so an agent never waits on a closed tab.
  handBackAfterMs?: number;
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
  // Each viewer (a chat card, a frame of a .browser file) shows its own tab.
  // key: the place showing it ("frame:<id>" for an editor frame, "card:<id>"),
  // client: the page load (one person's browser tab) it is in.
  private views = new Map<
    WebSocket,
    { tab: string | null; key: string; client: string; hidden?: boolean }
  >();
  // The tab each view key (e.g. an editor frame) last showed, so a frame
  // that reloads comes back to its own tab.
  private viewTabs = new Map<string, string>();
  private agentSockets = new Set<WebSocket>();
  private held: Array<{ client: WebSocket; deliver: () => void }> = [];
  private handBackTimer: NodeJS.Timeout | null = null;
  private state: SharedBrowserState;
  // Our own flat session on each tab someone looks at, and on the agents'
  // current tab: screencast, input, overlays.
  private pages = new Map<string, TabPage>();
  // The viewer whose "+" is creating a tab, so only it switches to it.
  private newTabFor: WebSocket | null = null;
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
      agentWaiting: false,
      cdp: "",
      viewers: 0,
    };
  }

  getState(): SharedBrowserState {
    return structuredClone(this.stateFor(this.state.active));
  }

  // The shared state as seen from one tab: its viewport and overlays.
  private stateFor(tab: string | null): SharedBrowserState {
    const page = tab ? this.pages.get(tab) : undefined;
    return {
      ...this.state,
      active: tab,
      viewport: page?.viewport ?? this.state.viewport,
      dialog: page?.dialog ?? null,
      select: page?.select ?? null,
      fileChooser: page?.fileChooser ?? null,
    };
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
      const query = new URL(req.url ?? "/", "http://x").searchParams;
      viewerWss.handleUpgrade(req, socket, head, (ws) =>
        this.addViewer(
          ws,
          `${query.get("view") ?? ""}`.slice(0, 200),
          `${query.get("client") ?? ""}`.slice(0, 200),
        ),
      );
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
    if (this.handBackTimer) clearTimeout(this.handBackTimer);
    for (const ws of [...this.views.keys(), ...this.agentSockets])
      ws.terminate();
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
      for (const page of this.pages.values()) {
        page.select = null;
        page.fileChooser = null;
      }
      const held = this.held;
      this.held = [];
      this.state.agentWaiting = false;
      for (const { deliver } of held) deliver();
    }
    for (const page of this.pages.values()) void this.applyDriverToPage(page);
    this.broadcastState();
  }

  ask(message: string): void {
    this.state.ask = {
      message: message.slice(0, 2000),
      at: new Date().toISOString(),
    };
    this.broadcastState();
  }

  private async applyDriverToPage(page: TabPage): Promise<void> {
    const session = page.session;
    if (!session) return;
    const human = this.state.driver === "human";
    // While the human drives, our session handles the file chooser; while
    // the agent drives, its own client may want to.
    await this.cdp
      .send("Page.setInterceptFileChooserDialog", { enabled: human }, session)
      .catch(() => {});
    await this.installSelectScript(page, human).catch(() => {});
  }

  private async installSelectScript(page: TabPage, human: boolean) {
    const session = page.session;
    if (!session) return;
    if (page.scriptId)
      await this.cdp
        .send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: page.scriptId },
          session,
        )
        .catch(() => {});
    const source = selectScript(human);
    const { identifier } = await this.cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
      session,
    );
    page.scriptId = identifier;
    await this.cdp
      .send("Runtime.evaluate", { expression: source }, session)
      .catch(() => {});
  }

  // --- tabs, our page sessions and what each viewer shows -----------------

  private addTab(info: any): void {
    if (info.type !== "page") return;
    if (this.state.tabs.some((tab) => tab.id === info.targetId)) return;
    this.state.tabs.push({
      id: info.targetId,
      url: info.url ?? "",
      title: info.title ?? "",
    });
  }

  private hasTab(targetId: string | null): targetId is string {
    return !!targetId && this.state.tabs.some((tab) => tab.id === targetId);
  }

  private pageFor(targetId: string): TabPage {
    let page = this.pages.get(targetId);
    if (!page) {
      page = {
        targetId,
        scale: 1,
        quality: "sharp",
        settleTimer: null,
        lastFrame: null,
        session: null,
        ready: null,
        casting: false,
        viewport: { ...this.state.viewport },
        dialog: null,
        select: null,
        fileChooser: null,
        fileChooserNode: null,
        selectContext: null,
        scriptId: null,
      };
      this.pages.set(targetId, page);
    }
    return page;
  }

  private attach(page: TabPage): Promise<void> {
    if (page.session) return Promise.resolve();
    if (!page.ready)
      page.ready = (async () => {
        const { sessionId } = await this.cdp.send("Target.attachToTarget", {
          targetId: page.targetId,
          flatten: true,
        });
        page.session = sessionId;
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
        await this.applyViewport(page);
        await this.applyDriverToPage(page);
      })().catch((err) => {
        page.ready = null;
        throw err;
      });
    return page.ready;
  }

  // Stop following a tab that nobody shows and agents do not use.
  private async release(targetId: string | null): Promise<void> {
    if (!targetId || targetId === this.state.active) return;
    if ([...this.views.values()].some((view) => view.tab === targetId)) return;
    const page = this.pages.get(targetId);
    if (!page) return;
    this.pages.delete(targetId);
    if (page.session)
      await this.cdp
        .send("Target.detachFromTarget", { sessionId: page.session })
        .catch(() => {});
  }

  private viewersOf(targetId: string): WebSocket[] {
    return [...this.views]
      .filter(([, view]) => view.tab === targetId)
      .map(([ws]) => ws);
  }

  // Viewers that can see their tab right now (hidden ones keep their last
  // frame and get no stream).
  private watchersOf(targetId: string): WebSocket[] {
    return [...this.views]
      .filter(([, view]) => view.tab === targetId && !view.hidden)
      .map(([ws]) => ws);
  }

  /**
   * The tab agents use and new viewers show.  Viewers that were showing the
   * previous one follow (as when an agent switches tabs); others keep theirs.
   */
  activate(targetId: string): Promise<void> {
    // Serialize switches; the latest request wins.
    this.switching = this.switching
      .then(async () => {
        if (!this.hasTab(targetId)) return;
        const previous = this.state.active;
        this.state.active = targetId;
        const moved: string[] = [];
        for (const view of this.views.values())
          if (!this.hasTab(view.tab) || view.tab === previous) {
            if (view.tab) moved.push(view.tab);
            view.tab = targetId;
          }
        await this.attach(this.pageFor(targetId));
        await this.updateCasting(targetId);
        for (const old of new Set([previous, ...moved])) {
          if (old && old !== targetId) {
            await this.updateCasting(old);
            await this.release(old);
          }
        }
        this.broadcastState();
      })
      .catch((err) => this.log(`switch tab: ${err?.message ?? err}`));
    return this.switching;
  }

  // One viewer switches tabs; the others keep showing theirs.
  private async show(ws: WebSocket, targetId: string): Promise<void> {
    const view = this.views.get(ws);
    if (!view || !this.hasTab(targetId)) return;
    const previous = view.tab;
    view.tab = targetId;
    // Agents act where the human last looked.
    this.state.active = targetId;
    await this.attach(this.pageFor(targetId));
    await this.updateCasting(targetId);
    if (previous && previous !== targetId) {
      await this.updateCasting(previous);
      await this.release(previous);
    }
    this.broadcastState();
  }

  private async applyViewport(page: TabPage): Promise<void> {
    if (!page.session) return;
    const { width, height } = page.viewport;
    await this.cdp
      .send(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: page.scale, mobile: false },
        page.session,
      )
      .catch(() => {});
    if (page.casting) {
      await this.cdp
        .send("Page.stopScreencast", {}, page.session)
        .catch(() => {});
      page.casting = false;
      await this.updateCasting(page.targetId);
    }
  }

  // Only stream a tab while someone is watching it.
  private async updateCasting(targetId: string): Promise<void> {
    const page = this.pages.get(targetId);
    if (!page?.session) return;
    const want = this.watchersOf(targetId).length > 0;
    if (want === page.casting) return;
    page.casting = want;
    page.lastFrame = null;
    if (want) {
      const { width, height } = page.viewport;
      await this.cdp.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: QUALITY[page.quality].jpeg,
          // Frames at the device pixels the viewer draws: no upscaling blur.
          maxWidth: Math.round(width * page.scale),
          maxHeight: Math.round(height * page.scale),
        },
        page.session,
      );
    } else {
      await this.cdp
        .send("Page.stopScreencast", {}, page.session)
        .catch(() => {});
    }
  }

  private sendFrame(page: TabPage, frame: Buffer): void {
    for (const ws of this.watchersOf(page.targetId)) {
      // Drop frames for slow viewers instead of queueing them.
      if (ws.bufferedAmount < 2 * 1024 * 1024) ws.send(frame, { binary: true });
    }
  }

  // Once the page is still, send it once at full quality.
  private async settle(page: TabPage): Promise<void> {
    page.settleTimer = null;
    const rest = QUALITY[page.quality].rest;
    if (!page.session || !page.casting || !rest) return;
    try {
      const { data } = await this.cdp.send(
        "Page.captureScreenshot",
        rest,
        page.session,
        10_000,
      );
      // Skip it if the page changed meanwhile: a newer frame is coming.
      if (!page.settleTimer && page.casting)
        this.sendFrame(page, Buffer.from(data, "base64"));
    } catch {
      // e.g. the tab closed
    }
  }

  private pageBySession(sessionId: string | undefined): TabPage | undefined {
    if (!sessionId) return;
    for (const page of this.pages.values())
      if (page.session === sessionId) return page;
  }

  private onCdpEvent(event: CdpEvent): void {
    const { method, params, sessionId } = event;
    if (method === "Target.targetCreated") {
      const before = this.state.tabs.length;
      this.addTab(params.targetInfo);
      if (this.state.tabs.length === before) return;
      const id = params.targetInfo.targetId;
      const opener = params.targetInfo.openerId;
      const requester = this.newTabFor;
      if (requester && this.views.has(requester)) {
        // This viewer's "+": only it switches to the new tab.
        this.newTabFor = null;
        void this.show(requester, id);
      } else if (opener && this.hasTab(opener)) {
        // A popup or target=_blank link comes to the front where it was
        // opened, as in a normal browser.
        for (const ws of this.viewersOf(opener)) void this.show(ws, id);
        void this.activate(id);
      } else {
        // An agent's new tab: shown where the agent's tab was.
        void this.activate(id);
      }
      this.broadcastState();
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
      this.pages.delete(params.targetId);
      const next =
        this.state.tabs[Math.min(index, this.state.tabs.length - 1)] ?? null;
      for (const view of this.views.values())
        if (view.tab === params.targetId) view.tab = next?.id ?? null;
      if (this.state.active === params.targetId) {
        this.state.active = null;
        if (next) void this.activate(next.id);
      } else if (next) {
        void this.attach(this.pageFor(next.id))
          .then(() => this.updateCasting(next.id))
          .catch(() => {});
      }
      if (!next)
        void this.cdp
          .send("Target.createTarget", { url: "about:blank" })
          .catch(() => {});
      this.broadcastState();
      return;
    }
    const page = this.pageBySession(sessionId);
    if (!page) return;
    if (method === "Page.screencastFrame") {
      this.cdp.notify(
        "Page.screencastFrameAck",
        { sessionId: params.sessionId },
        sessionId,
      );
      const frame = Buffer.from(params.data, "base64");
      // Capturing the still frame makes Chromium send the same picture
      // again: forwarding it would replace the sharp frame and start over.
      if (page.lastFrame?.equals(frame)) return;
      page.lastFrame = frame;
      this.sendFrame(page, frame);
      if (QUALITY[page.quality].rest) {
        if (page.settleTimer) clearTimeout(page.settleTimer);
        page.settleTimer = setTimeout(() => void this.settle(page), SETTLE_MS);
      }
      return;
    }
    if (method === "Page.javascriptDialogOpening") {
      page.dialog = {
        type: params.type,
        message: params.message ?? "",
        defaultPrompt: params.defaultPrompt,
      };
      this.broadcastState();
      return;
    }
    if (method === "Page.javascriptDialogClosed") {
      page.dialog = null;
      this.broadcastState();
      return;
    }
    if (method === "Page.fileChooserOpened") {
      page.fileChooserNode = params.backendNodeId ?? null;
      page.fileChooser = { mode: params.mode };
      this.broadcastState();
      return;
    }
    if (method === "Runtime.bindingCalled" && params.name === SELECT_BINDING) {
      try {
        const payload = JSON.parse(params.payload);
        page.selectContext = params.executionContextId;
        page.select = {
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

  private addViewer(ws: WebSocket, key = "", client = ""): void {
    const remembered = key ? (this.viewTabs.get(key) ?? null) : null;
    const tab = this.hasTab(remembered) ? remembered : this.state.active;
    // A new frame next to another frame of the same person on this tab is a
    // split: like a new terminal, it gets a tab of its own (the same page).
    // Collaborators and chat cards keep sharing what they see.
    const split =
      !this.hasTab(remembered) &&
      !!tab &&
      !!client &&
      key.startsWith("frame:") &&
      [...this.views.values()].some(
        (view) =>
          view.client === client &&
          view.key !== key &&
          view.key.startsWith("frame:") &&
          view.tab === tab,
      );
    this.views.set(ws, { tab, key, client });
    this.state.viewers = this.views.size;
    if (this.handBackTimer) clearTimeout(this.handBackTimer);
    this.handBackTimer = null;
    if (this.options.humanFirst && this.agentSockets.size === 0)
      this.setDriver("human");
    ws.send(JSON.stringify({ type: "state", state: this.stateFor(tab) }));
    if (tab)
      void this.attach(this.pageFor(tab))
        .then(() => this.updateCasting(tab))
        .catch(() => {});
    if (split && tab) {
      const url =
        this.state.tabs.find((t) => t.id === tab)?.url || "about:blank";
      this.newTabFor = ws;
      void this.cdp
        .send("Target.createTarget", { url })
        .catch((err) => this.log(`split: ${err?.message ?? err}`));
    }
    this.broadcastState();
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onViewerMessage(ws, msg).catch((err) =>
        ws.send(
          JSON.stringify({ type: "error", message: `${err?.message ?? err}` }),
        ),
      );
    });
    ws.on("close", () => {
      const tab = this.views.get(ws)?.tab ?? null;
      this.views.delete(ws);
      if (this.newTabFor === ws) this.newTabFor = null;
      this.state.viewers = this.views.size;
      if (tab)
        void this.updateCasting(tab)
          .then(() => this.release(tab))
          .catch(() => {});
      this.broadcastState();
      if (this.views.size === 0 && this.state.driver === "human") {
        if (this.handBackTimer) clearTimeout(this.handBackTimer);
        // A grace period, e.g. for a reload of the page.
        this.handBackTimer = setTimeout(() => {
          this.handBackTimer = null;
          if (this.views.size === 0) this.setDriver("agent");
        }, this.options.handBackAfterMs ?? 15_000);
      }
    });
  }

  private rememberViews(): void {
    for (const view of this.views.values())
      if (view.key && view.tab) {
        this.viewTabs.delete(view.key);
        this.viewTabs.set(view.key, view.tab);
      }
    while (this.viewTabs.size > 200)
      this.viewTabs.delete(this.viewTabs.keys().next().value!);
  }

  private broadcastState(): void {
    this.rememberViews();
    for (const [ws, view] of this.views)
      ws.send(
        JSON.stringify({ type: "state", state: this.stateFor(view.tab) }),
      );
  }

  private async onViewerMessage(ws: WebSocket, msg: any): Promise<void> {
    const view = this.views.get(ws);
    if (!view) return;
    switch (msg.type) {
      case "takeover":
        return this.setDriver("human");
      case "handback":
        return this.setDriver("agent");
      case "resize": {
        if (!view.tab) return;
        const page = this.pageFor(view.tab);
        const width = clampInt(msg.width, 200, MAX_VIEWPORT);
        const height = clampInt(msg.height, 150, MAX_VIEWPORT);
        const quality: ViewQuality =
          msg.quality === "balanced" || msg.quality === "fast"
            ? msg.quality
            : "sharp";
        const ratio = Number(msg.scale);
        const scale = Math.min(
          QUALITY[quality].maxScale,
          Math.max(1, Number.isFinite(ratio) ? Math.round(ratio * 4) / 4 : 1),
        );
        // New tabs start at the size the human last used.
        this.state.viewport = { width, height };
        if (
          width === page.viewport.width &&
          height === page.viewport.height &&
          scale === page.scale &&
          quality === page.quality
        )
          return;
        page.viewport = { width, height };
        page.scale = scale;
        page.quality = quality;
        await this.applyViewport(page);
        this.broadcastState();
        return;
      }
      case "tab":
        if (typeof msg.id === "string") await this.show(ws, msg.id);
        return;
      case "visible": {
        view.hidden = !msg.visible;
        if (!view.tab) return;
        const page = this.pages.get(view.tab);
        if (view.hidden || !page?.session) {
          await this.updateCasting(view.tab);
          return;
        }
        // A screencast only sends frames when the page changes: restart it
        // so the returning viewer gets the current picture at once.
        if (page.casting) {
          await this.cdp
            .send("Page.stopScreencast", {}, page.session)
            .catch(() => {});
          page.casting = false;
        }
        await this.updateCasting(view.tab);
        return;
      }
    }
    // Everything below acts on the page: only while the human drives.
    if (this.state.driver !== "human") return;
    if (msg.type === "newTab") {
      this.newTabFor = ws;
      await this.cdp.send("Target.createTarget", { url: "about:blank" });
      return;
    }
    if (msg.type === "closeTab") {
      if (typeof msg.id === "string")
        await this.cdp.send("Target.closeTarget", { targetId: msg.id });
      return;
    }
    const page = view.tab ? this.pages.get(view.tab) : undefined;
    const s = page?.session;
    if (!page || !s) return;
    // Agents act where the human is working.
    this.state.active = page.targetId;
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
        page.select = null;
        this.broadcastState();
        if (
          Number.isInteger(msg.index) &&
          msg.index >= 0 &&
          page.selectContext != null
        )
          await this.cdp.send(
            "Runtime.evaluate",
            {
              expression: pickSelectExpression(msg.index),
              contextId: page.selectContext,
            },
            s,
          );
        return;
      }
      case "file": {
        const node = page.fileChooserNode;
        page.fileChooser = null;
        page.fileChooserNode = null;
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
    // Paths are matched by suffix: proxies may or may not strip their prefix.
    if (
      req.method === "GET" &&
      (path.endsWith("/") || path.endsWith("/index.html"))
    ) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(VIEWER_HTML);
      return;
    }
    if (path.endsWith("/api/state") && req.method === "GET") {
      return json(res, 200, this.getState());
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
        ![...this.pages.values()].some((page) => page.dialog)
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
      for (const data of pending.splice(0))
        this.forwardAgent(data, deliver, client);
    });
    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data.toString());
    });
    client.on("message", (data) => {
      if (!open) pending.push(data);
      else this.forwardAgent(data, deliver, client);
    });
    const end = () => {
      if (!this.agentSockets.delete(client)) return;
      this.state.agents = this.agentSockets.size;
      // Its held commands have nowhere to go.
      this.held = this.held.filter((entry) => entry.client !== client);
      this.state.agentWaiting = this.held.length > 0;
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
    client: WebSocket,
  ): void {
    const method = parseMessage(data.toString())?.method;
    if (
      this.state.driver === "human" &&
      typeof method === "string" &&
      HELD_WHILE_HUMAN_DRIVES.test(method)
    ) {
      this.held.push({ client, deliver: () => deliver(data) });
      if (!this.state.agentWaiting) {
        this.state.agentWaiting = true;
        this.broadcastState();
      }
    } else deliver(data);
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
