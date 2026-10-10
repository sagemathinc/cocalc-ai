/**
 * Shared browser: one headless Chromium in the project that an agent drives
 * over the Chrome DevTools Protocol (CDP) and a human watches and uses
 * through the viewer in CoCalc's frontend (a chat card, a .browser file).
 *
 * Viewers connect over the user's own conat connection (see
 * viewer-socket.ts and @cocalc/util/shared-browser-protocol): screencast
 * frames, state, the human's input.  Two loopback listeners serve the
 * project itself:
 * - the app port: a small JSON API used by the CLI (and the app manager's
 *   health check);
 * - a CDP port for agents, proxied to Chromium.  While the human has taken
 *   over, agent commands are held and delivered on hand-back.
 * Neither is for anyone outside the project: both refuse requests that come
 * through CoCalc's proxy, which can reach any port in the project.
 *
 * Headless Chromium draws neither native <select> popups nor dialogs into
 * the screencast; those are reported to the viewer, which draws them.
 */
import http from "node:http";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

import { CdpClient, type CdpEvent } from "./cdp-client";
import {
  MAX_CLIPBOARD_TEXT,
  pickSelectExpression,
  ICON_EXPRESSION,
  SELECT_BINDING,
  selectScript,
} from "./page-script";
import type { SharedBrowserRunsOn } from "@cocalc/util/shared-browser";
import type {
  Driver,
  FaviconData,
  SharedBrowserNetwork,
  ServiceMessage,
  SharedBrowserState,
  StartPageData,
  ViewerMessage,
  ViewerRequest,
  ViewQuality,
} from "@cocalc/util/shared-browser-protocol";
import { Favicons, projectServers } from "./start-page";

export type {
  Driver,
  SharedBrowserState,
  SharedBrowserTab,
  ViewQuality,
} from "@cocalc/util/shared-browser-protocol";

/** One viewer's connection (see viewer-socket.ts). */
export interface ViewerChannel {
  send(message: ServiceMessage): void;
  // A frame of the screen.  The channel keeps only a few unacknowledged and
  // replaces the rest by the newest, so a slow viewer gets fewer frames.
  sendFrame(frame: Buffer): void;
}

export interface ViewerHello {
  view?: string;
  client?: string;
  site?: string;
}

// The screencast streams changes as JPEG; once the page is still, one frame
// replaces it: lossless PNG (sharp) or high-quality JPEG (balanced).  Fast
// skips that (slow links).  All at the page's CSS pixels: rendering at the
// viewer's pixel ratio broke input and screenshots (see applyViewport).
const QUALITY: Record<
  ViewQuality,
  {
    jpeg: number;
    rest: null | { format: string; quality?: number };
  }
> = {
  sharp: { jpeg: 80, rest: { format: "png" } },
  balanced: { jpeg: 75, rest: { format: "jpeg", quality: 92 } },
  fast: { jpeg: 60, rest: null },
};
// A lossless frame this long after the last change, in sharp mode.
const SETTLE_MS = 350;

interface TabPage {
  targetId: string;
  // The viewer's picture quality.
  quality: ViewQuality;
  settleTimer: NodeJS.Timeout | null;
  // The last screencast frame, to recognize frames without a change.
  lastFrame: Buffer | null;
  settledAt: number;
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
  // The page's selected text, for the human's clipboard.
  selection: string;
  zoom: number;
}

export interface SharedBrowserServerOptions {
  /**
   * Chromium's own browser-level DevTools URL (ws://127.0.0.1:N/devtools/browser/ID).
   * Without it the server waits for attachChrome().
   */
  chromeWebSocketUrl?: string;
  host: string;
  port: number;
  cdpPort: number;
  // A .browser file's browser is the human's: whoever opens it drives,
  // unless an agent is using it.
  humanFirst?: boolean;
  // Hand back to the agent this long after the last viewer leaves while the
  // human drives, so an agent never waits on a closed tab.
  handBackAfterMs?: number;
  // A .browser file's browser: where it runs, the command that connects the
  // user's computer, and what to do when the viewer switches.
  runsOn?: SharedBrowserRunsOn;
  connectCommand?: string;
  onRunsOn?: (runsOn: SharedBrowserRunsOn) => void | Promise<void>;
  // A browser in its own container: switch its network.
  onNetwork?: (network: SharedBrowserNetwork) => void | Promise<void>;
  // For the start page: this browser's name, and the sites it visited.
  title?: string;
  recent?: () => StartPageData["recent"];
  // What a page's file chooser gets for these project files (a browser in
  // its own container gets copies it can see).
  offerFiles?: (paths: string[]) => string[];
  // Only these ports for the start page's servers (tests).
  startPagePorts?: number[];
  log?: (message: string) => void;
}

const MAX_VIEWPORT = 3840;

// While the human drives, an agent's commands wait for hand-back, all but
// this housekeeping, which acts on no page: a client keeps its sessions (and
// a popup the human opens starts, which waits for runIfWaitingForDebugger).
// Fail closed: anything else waits, including commands tunneled to a target
// (Target.sendMessageToTarget), cookies, DOM changes, scripts, screenshots.
// This pauses agents that use the browser through here; it is no barrier
// against code in the project, which can reach Chromium directly.
export const PASSES_WHILE_HUMAN_DRIVES: ReadonlySet<string> = new Set([
  "Browser.getVersion",
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.getBrowserContexts",
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Target.attachToTarget",
  "Target.attachToBrowserTarget",
  "Target.detachFromTarget",
  "Runtime.runIfWaitingForDebugger",
  "Runtime.enable",
  "Runtime.disable",
  "Page.enable",
  "Page.disable",
  "Page.getFrameTree",
  "Page.setLifecycleEventsEnabled",
]);

export function heldWhileHumanDrives(method: unknown): boolean {
  return typeof method !== "string" || !PASSES_WHILE_HUMAN_DRIVES.has(method);
}

export class SharedBrowserServer {
  // The attached browser (none while waiting for the user's computer).
  private cdp!: CdpClient;
  // Where the attached browser's DevTools are.
  private devtools: DevToolsEndpoint | null = null;
  private appServer!: http.Server;
  private favicons = new Favicons();
  // Ours, not the user's servers.
  private ownPorts = new Set<number>();
  private cdpServer!: http.Server;
  // Each viewer (a chat card, a frame of a .browser file) shows its own tab.
  // key: the place showing it ("frame:<id>" for an editor frame, "card:<id>"),
  // client: the page load (one person's browser tab) it is in.
  private views = new Map<
    ViewerChannel,
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
  private newTabFor: ViewerChannel | null = null;
  private switching: Promise<void> = Promise.resolve();
  private titleTimer: NodeJS.Timeout | null = null;
  private log: (message: string) => void;

  constructor(private readonly options: SharedBrowserServerOptions) {
    this.log = options.log ?? (() => {});
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
      connection: "waiting",
      runsOn: options.runsOn ?? null,
      connectCommand: options.connectCommand ?? null,
      title: options.title ?? "Web browser",
      zoom: 1,
      network: null,
    };
  }

  get attached(): boolean {
    return this.devtools != null;
  }

  // A browser on the user's computer is theirs: we only stream a small
  // preview.  Enabling domains, injecting scripts and emulating a viewport
  // are what sites' bot detection looks for (X refused a login), and the
  // emulation would fight the real window for its size.
  private get lightTouch(): boolean {
    return this.state.runsOn === "computer";
  }

  // The site the user is on (for `connect --api`), from the viewer.
  private siteOrigin = "";
  private noteOrigin(origin: string | undefined): void {
    if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) return;
    if (origin === this.siteOrigin || !this.options.connectCommand) return;
    this.siteOrigin = origin;
    this.state.connectCommand = `${this.options.connectCommand} --api ${origin}`;
  }

  setNetwork(network: SharedBrowserNetwork | null): void {
    if (this.state.network === network) return;
    this.state.network = network;
    this.broadcastState();
  }

  setRunsOn(runsOn: SharedBrowserRunsOn): void {
    if (this.state.runsOn === runsOn) return;
    this.state.runsOn = runsOn;
    this.broadcastState();
  }

  /** Use this browser (e.g. the user's, through a tunnel). */
  async attachChrome(webSocketUrl: string): Promise<void> {
    if (this.attached) this.detachChrome();
    const cdp = await CdpClient.connect(webSocketUrl);
    this.cdp = cdp;
    this.devtools = devToolsEndpoint(webSocketUrl);
    if (this.devtools.port) this.ownPorts.add(this.devtools.port);
    cdp.on((event) => {
      if (this.cdp === cdp) this.onCdpEvent(event);
    });
    void cdp.closed.then(() => {
      if (this.cdp === cdp) {
        this.log("the browser disconnected");
        this.detachChrome();
      }
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const info of targetInfos) this.addTab(info);
    this.state.connection = "connected";
    if (this.state.tabs.length === 0) {
      await cdp.send("Target.createTarget", { url: "about:blank" });
    } else {
      await this.activate(this.state.tabs[this.state.tabs.length - 1].id);
    }
    this.broadcastState();
  }

  /** Forget the browser: back to waiting (viewers and agents are told). */
  detachChrome(): void {
    if (!this.attached) return;
    const cdp = this.cdp;
    this.devtools = null;
    this.state.connection = "waiting";
    this.state.tabs = [];
    this.state.active = null;
    for (const page of this.pages.values())
      if (page.settleTimer) clearTimeout(page.settleTimer);
    this.pages.clear();
    for (const view of this.views.values()) view.tab = null;
    // Agents' connections went to that browser.
    this.held = [];
    this.state.agentWaiting = false;
    for (const ws of this.agentSockets) ws.terminate();
    cdp?.close();
    this.broadcastState();
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
      zoom: page?.zoom ?? this.state.zoom,
      dialog: page?.dialog ?? null,
      select: page?.select ?? null,
      fileChooser: page?.fileChooser ?? null,
    };
  }

  async start(): Promise<{ port: number; cdpPort: number }> {
    if (this.options.chromeWebSocketUrl)
      await this.attachChrome(this.options.chromeWebSocketUrl);

    this.appServer = http.createServer((req, res) =>
      this.onAppRequest(req, res),
    );
    this.appServer.on("upgrade", (_req, socket) => socket.destroy());
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
      if (!path.startsWith("/devtools/") || fromOutsideProject(req)) {
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
    this.ownPorts.add(port).add(cdpPort);
    this.titleTimer = setInterval(() => void this.refreshTitles(), 2000);
    this.titleTimer.unref?.();
    this.log(
      `API on ${this.options.host}:${port}, agent CDP on ${this.state.cdp}`,
    );
    return { port, cdpPort };
  }

  async close(): Promise<void> {
    if (this.handBackTimer) clearTimeout(this.handBackTimer);
    if (this.titleTimer) clearInterval(this.titleTimer);
    this.views.clear();
    for (const ws of this.agentSockets) ws.terminate();
    await Promise.all([
      closeServer(this.appServer),
      closeServer(this.cdpServer),
    ]);
    if (this.attached) this.cdp.close();
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
    if (!session || this.lightTouch) return;
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
        quality: "balanced",
        settleTimer: null,
        lastFrame: null,
        settledAt: 0,
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
        selection: "",
        zoom: this.state.zoom,
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
        if (this.lightTouch) return;
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

  private viewersOf(targetId: string): ViewerChannel[] {
    return [...this.views]
      .filter(([, view]) => view.tab === targetId)
      .map(([channel]) => channel);
  }

  // Viewers that can see their tab right now (hidden ones keep their last
  // frame and get no stream).
  private watchersOf(targetId: string): ViewerChannel[] {
    return [...this.views]
      .filter(([, view]) => view.tab === targetId && !view.hidden)
      .map(([channel]) => channel);
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
  private async show(channel: ViewerChannel, targetId: string): Promise<void> {
    const view = this.views.get(channel);
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
    this.sendSelection(channel);
    this.broadcastState();
  }

  private async applyViewport(page: TabPage): Promise<void> {
    if (!page.session || this.lightTouch) return;
    const { width, height } = page.viewport;
    const zoom = page.zoom;
    await this.cdp
      .send(
        "Emulation.setDeviceMetricsOverride",
        // Not the viewer's pixel ratio: with it, a screenshot left input
        // scaled (clicks at half the distance), and scaled-clip screenshots
        // misrendered on some hosts (tiled, shifted).  Page zoom is a pixel
        // ratio too, but with the viewport divided by it, as a browser zooms
        // (the viewer's coordinates are divided by it in turn; tested with
        // screenshots).
        {
          width: Math.max(1, Math.round(width / zoom)),
          height: Math.max(1, Math.round(height / zoom)),
          deviceScaleFactor: zoom,
          mobile: false,
        },
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

  private async reapplyZoom(): Promise<void> {
    for (const page of this.pages.values()) {
      if (!page.session || page.zoom === 1 || this.lightTouch) continue;
      // The same override again is ignored (Chromium 149): clear it first.
      await this.cdp
        .send("Emulation.clearDeviceMetricsOverride", {}, page.session)
        .catch(() => {});
      await this.cdp
        .send(
          "Emulation.setDeviceMetricsOverride",
          {
            width: Math.max(1, Math.round(page.viewport.width / page.zoom)),
            height: Math.max(1, Math.round(page.viewport.height / page.zoom)),
            deviceScaleFactor: page.zoom,
            mobile: false,
          },
          page.session,
        )
        .catch(() => {});
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
      const { width, height } = this.lightTouch
        ? { width: 960, height: 960 } // a preview of the real window
        : page.viewport;
      await this.cdp.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: this.lightTouch ? 50 : QUALITY[page.quality].jpeg,
          // Frames at the device pixels the viewer draws: no upscaling blur.
          maxWidth: width,
          maxHeight: height,
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
    for (const channel of this.watchersOf(page.targetId))
      channel.sendFrame(frame);
  }

  // Once the page is still, send it once at full quality.
  private async settle(page: TabPage): Promise<void> {
    page.settleTimer = null;
    const rest = restFrame(page);
    if (!page.session || !page.casting || !rest) return;
    try {
      // The page exactly as the stream shows it, without JPEG artifacts.
      const { data } = await this.cdp.send(
        "Page.captureScreenshot",
        rest,
        page.session,
        10_000,
      );
      page.settledAt = Date.now();
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
      if (restFrame(page) && !this.lightTouch) {
        if (page.settleTimer) clearTimeout(page.settleTimer);
        // At most one still frame a second, whatever keeps the page busy.
        const wait = Math.max(SETTLE_MS, page.settledAt + 1000 - Date.now());
        page.settleTimer = setTimeout(() => void this.settle(page), wait);
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
    if (method === "Page.frameNavigated" && !params.frame?.parentId) {
      if (page.selection) this.setSelection(page, "");
      const tab = this.state.tabs.find((t) => t.id === page.targetId);
      if (tab?.icon) {
        delete tab.icon;
        this.broadcastState();
      }
      return;
    }
    if (method === "Page.loadEventFired") {
      void this.updateIcon(page);
      void this.refreshTitles();
      return;
    }
    if (method === "Runtime.bindingCalled" && params.name === SELECT_BINDING) {
      try {
        const payload = JSON.parse(params.payload);
        if (payload.type === "selection" || payload.type === "copied") {
          const text = `${payload.text ?? ""}`.slice(0, MAX_CLIPBOARD_TEXT);
          if (payload.type === "selection") this.setSelection(page, text);
          else
            for (const channel of this.viewersOf(page.targetId))
              channel.send({ type: "copied", text });
          return;
        }
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

  /**
   * Chromium reports a tab's title only when the tab navigates, before the
   * page sets one (so it is the URL): keep titles current while someone
   * watches, also those a page sets later.
   */
  private async refreshTitles(): Promise<void> {
    if (!this.attached || this.views.size === 0) return;
    let infos: any[] = [];
    try {
      infos = (await this.cdp.send("Target.getTargets")).targetInfos ?? [];
    } catch {
      return;
    }
    let changed = false;
    for (const info of infos) {
      const tab = this.state.tabs.find((t) => t.id === info.targetId);
      if (!tab) continue;
      if (typeof info.title === "string" && info.title !== tab.title) {
        tab.title = info.title;
        changed = true;
      }
      if (typeof info.url === "string" && info.url !== tab.url) {
        tab.url = info.url;
        changed = true;
      }
    }
    if (changed) this.broadcastState();
  }

  // The page's icon, for its tab.
  private async updateIcon(page: TabPage): Promise<void> {
    if (!page.session) return;
    const { result } = await this.cdp
      .send(
        "Runtime.evaluate",
        { expression: ICON_EXPRESSION, returnByValue: true },
        page.session,
      )
      .catch(() => ({ result: null as any }));
    const icon = typeof result?.value === "string" ? result.value : "";
    const tab = this.state.tabs.find((t) => t.id === page.targetId);
    if (!tab || (tab.icon ?? "") === icon) return;
    if (icon) tab.icon = icon;
    else delete tab.icon;
    this.broadcastState();
  }

  private setSelection(page: TabPage, text: string): void {
    page.selection = text;
    for (const channel of this.viewersOf(page.targetId))
      this.sendSelection(channel);
  }

  // What is selected in the tab a viewer shows.
  private sendSelection(channel: ViewerChannel): void {
    const tab = this.views.get(channel)?.tab;
    const text = (tab && this.pages.get(tab)?.selection) || "";
    channel.send({ type: "selection", text });
  }

  // --- viewers -------------------------------------------------------------

  /**
   * A viewer said hello: on connecting, or again after a reconnect (then it
   * keeps its tab).
   */
  addViewer(channel: ViewerChannel, hello: ViewerHello = {}): void {
    this.noteOrigin(hello.site);
    const known = this.views.get(channel);
    if (known) {
      known.hidden = false;
      channel.send({ type: "state", state: this.stateFor(known.tab) });
      this.sendSelection(channel);
      if (known.tab) void this.restartCasting(known.tab);
      return;
    }
    const key = `${hello.view ?? ""}`.slice(0, 200);
    const client = `${hello.client ?? ""}`.slice(0, 200);
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
    this.views.set(channel, { tab, key, client });
    this.state.viewers = this.views.size;
    if (this.handBackTimer) clearTimeout(this.handBackTimer);
    this.handBackTimer = null;
    if (this.options.humanFirst && this.agentSockets.size === 0)
      this.setDriver("human");
    channel.send({ type: "state", state: this.stateFor(tab) });
    this.sendSelection(channel);
    if (tab)
      void this.attach(this.pageFor(tab))
        .then(() => this.updateCasting(tab))
        .catch(() => {});
    if (split && tab && this.attached) {
      const url =
        this.state.tabs.find((t) => t.id === tab)?.url || "about:blank";
      this.newTabFor = channel;
      void this.cdp
        .send("Target.createTarget", { url })
        .catch((err) => this.log(`split: ${err?.message ?? err}`));
    }
    this.broadcastState();
  }

  /** The viewer went away (closed, or gone for good). */
  removeViewer(channel: ViewerChannel): void {
    if (!this.views.has(channel)) return;
    const tab = this.views.get(channel)?.tab ?? null;
    this.views.delete(channel);
    if (this.newTabFor === channel) this.newTabFor = null;
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
  }

  /** What a viewer says; errors go back to it. */
  async viewerMessage(
    channel: ViewerChannel,
    msg: ViewerMessage,
  ): Promise<void> {
    try {
      await this.onViewerMessage(channel, msg);
    } catch (err: any) {
      channel.send({ type: "error", message: `${err?.message ?? err}` });
    }
  }

  /** What a viewer asks: a new tab's start page, a site's icon. */
  async viewerRequest(
    channel: ViewerChannel,
    request: ViewerRequest,
  ): Promise<StartPageData | FaviconData> {
    if (!this.views.has(channel)) throw Error("say hello first");
    if (request?.type === "start") return await this.startPage();
    if (request?.type === "favicon") {
      const icon = await this.favicons.get(`${request.url ?? ""}`);
      return icon ? { type: icon.type, body: icon.body } : null;
    }
    throw Error("unknown request");
  }

  // The servers running in the project and the sites visited recently.
  private async startPage(): Promise<StartPageData> {
    if (this.lightTouch) return { servers: [], recent: [] };
    const only = this.options.startPagePorts;
    const servers = await projectServers(
      this.ownPorts,
      undefined,
      only ? new Set(only) : undefined,
    ).catch(() => []);
    let recent: StartPageData["recent"] = [];
    try {
      recent = this.options.recent?.() ?? [];
    } catch {}
    return { servers, recent };
  }

  // A screencast only sends frames when the page changes: restart it so a
  // returning viewer gets the current picture at once.
  private async restartCasting(targetId: string): Promise<void> {
    const page = this.pages.get(targetId);
    if (page?.casting && page.session) {
      await this.cdp
        .send("Page.stopScreencast", {}, page.session)
        .catch(() => {});
      page.casting = false;
    }
    await this.updateCasting(targetId).catch(() => {});
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
    for (const [channel, view] of this.views)
      channel.send({ type: "state", state: this.stateFor(view.tab) });
  }

  private async onViewerMessage(
    channel: ViewerChannel,
    msg: any,
  ): Promise<void> {
    const view = this.views.get(channel);
    if (!view) return;
    switch (msg.type) {
      case "takeover":
        return this.setDriver("human");
      case "handback":
        return this.setDriver("agent");
      case "runsOn":
        if (
          this.state.runsOn &&
          (msg.value === "project" || msg.value === "computer")
        )
          await this.options.onRunsOn?.(msg.value);
        return;
      case "network":
        if (
          this.state.network &&
          (msg.value === "own" || msg.value === "project")
        )
          await this.options.onNetwork?.(msg.value);
        return;
      case "resize": {
        if (!view.tab) return;
        const page = this.pageFor(view.tab);
        const width = clampInt(msg.width, 200, MAX_VIEWPORT);
        const height = clampInt(msg.height, 150, MAX_VIEWPORT);
        const quality: ViewQuality =
          msg.quality === "sharp" || msg.quality === "fast"
            ? msg.quality
            : "balanced";
        // New tabs start at the size the human last used.
        this.state.viewport = { width, height };
        if (
          width === page.viewport.width &&
          height === page.viewport.height &&
          quality === page.quality
        )
          return;
        page.viewport = { width, height };
        page.quality = quality;
        await this.applyViewport(page);
        this.broadcastState();
        return;
      }
      case "tab":
        if (typeof msg.id === "string") await this.show(channel, msg.id);
        return;
      // A viewing preference, so whoever watches may zoom, driving or not.
      case "zoom": {
        if (!view.tab || this.lightTouch) return;
        const zoom = clampZoom(msg.zoom);
        const page = this.pageFor(view.tab);
        this.state.zoom = zoom;
        if (zoom === page.zoom) return;
        page.zoom = zoom;
        await this.applyViewport(page);
        this.broadcastState();
        return;
      }
      case "visible": {
        view.hidden = !msg.visible;
        if (!view.tab) return;
        if (view.hidden) await this.updateCasting(view.tab);
        else await this.restartCasting(view.tab);
        return;
      }
    }
    // Everything below acts on the page: only while the human drives, and
    // not on the user's computer (they use its window).
    if (this.state.driver !== "human" || !this.attached || this.lightTouch)
      return;
    if (msg.type === "newTab") {
      this.newTabFor = channel;
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
              // The viewer's pixels; the page's are larger when zoomed.
              x: num(msg.x) / page.zoom,
              y: num(msg.y) / page.zoom,
              button: msg.button ?? "none",
              buttons: msg.buttons,
              clickCount: msg.clickCount ?? 0,
              deltaX: num(msg.deltaX) / page.zoom,
              deltaY: num(msg.deltaY) / page.zoom,
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
        let files = (Array.isArray(msg.paths) ? msg.paths : [])
          .map((p: unknown) => resolveProjectFile(`${p}`))
          .filter((p: string | null): p is string => !!p);
        if (files.length && this.options.offerFiles)
          files = this.options.offerFiles(files);
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

  // --- app HTTP: the CLI's API ------------------------------------------------

  private onAppRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/healthz" || path.endsWith("/healthz"))
      return json(res, 200, { ok: true });
    // For the CLI in the project only.  Viewers use conat.
    if (fromOutsideProject(req))
      return json(res, 403, { error: "only from inside the project" });
    // Paths are matched by suffix: proxies may or may not strip their prefix.
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
    json(res, 404, { error: "not found" });
  }

  // --- agent CDP proxy ------------------------------------------------------

  private async onCdpHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (fromOutsideProject(req))
      return json(res, 403, { error: "only from inside the project" });
    if (!url.pathname.startsWith("/json"))
      return json(res, 404, { error: "not found" });
    if (!this.attached)
      return json(res, 503, {
        error:
          "the browser is not connected: it runs on the user's computer, which is not connected now",
      });
    // These act on the browser (open, close or bring tabs to the front): not
    // while the human drives.  Listing passes.
    if (
      this.state.driver === "human" &&
      /^\/json\/(new|close|activate)\b/.test(url.pathname)
    )
      return json(res, 409, {
        error:
          "the human is driving this browser; try again after they hand it back",
      });
    try {
      const upstream = await devToolsRequest(
        this.devtools!,
        `${url.pathname}${url.search}`,
        req.method === "PUT" ? "PUT" : "GET",
      );
      const ours = `127.0.0.1:${(this.cdpServer.address() as any).port}`;
      res.writeHead(upstream.status, {
        "content-type": upstream.contentType ?? "application/json",
      });
      // A browser behind a tunnel or in its own container reports its own
      // (other) address: rewrite every DevTools address to ours.
      let text = upstream.text;
      if (this.devtools?.host) text = text.split(this.devtools.host).join(ours);
      res.end(
        // (Through a socket, Chromium names no port at all.)
        text.replace(
          /(ws:\/\/|ws=)(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/g,
          `$1${ours}`,
        ),
      );
    } catch (err: any) {
      json(res, 502, { error: `${err?.message ?? err}` });
    }
  }

  private addAgent(client: WebSocket, path: string): void {
    if (!this.attached) {
      client.close(1013, "the browser is not connected");
      return;
    }
    const upstream = new WebSocket(devToolsWebSocketUrl(this.devtools!, path), {
      perMessageDeflate: false,
      maxPayload: 0,
    });
    const pending: Array<WebSocket.RawData> = [];
    let open = false;
    // Screenshots of part of the page, by message id (see below).
    const clipShots = new Set<number>();
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
      if (msg?.method === "Page.captureScreenshot" && msg.params?.clip)
        clipShots.add(msg.id);
      upstream.send(text);
    };
    upstream.on("open", () => {
      open = true;
      for (const data of pending.splice(0))
        this.forwardAgent(data, deliver, client);
    });
    upstream.on("message", (data) => {
      const text = data.toString();
      if (client.readyState === WebSocket.OPEN) client.send(text);
      // A clipped screenshot (Playwright's) leaves a zoomed page at pixel
      // ratio 1: zoom it again.  Replies start with their id.
      if (clipShots.size > 0) {
        const id = Number(text.match(/^\{"id":(\d+)/)?.[1]);
        if (clipShots.delete(id)) void this.reapplyZoom();
      }
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
    if (this.state.driver === "human" && heldWhileHumanDrives(method)) {
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

/**
 * Chromium's DevTools: on a TCP port (a browser in the project, or on the
 * user's computer through a tunnel), or behind a unix socket (a browser in
 * its own container).  The URL is its browser WebSocket's:
 * ws://127.0.0.1:N/devtools/browser/ID or
 * ws+unix:///path/cdp.sock:/devtools/browser/ID.
 */
export interface DevToolsEndpoint {
  host?: string; // "127.0.0.1:N"
  port?: number;
  socketPath?: string;
}

export function devToolsEndpoint(webSocketUrl: string): DevToolsEndpoint {
  const unix = webSocketUrl.match(/^ws\+unix:\/\/(\/[^:]+):\//);
  if (unix) return { socketPath: unix[1] };
  const url = new URL(webSocketUrl);
  return { host: url.host, port: Number(url.port) || undefined };
}

export function devToolsWebSocketUrl(
  endpoint: DevToolsEndpoint,
  path: string,
): string {
  return endpoint.socketPath
    ? `ws+unix://${endpoint.socketPath}:${path}`
    : `ws://${endpoint.host}${path}`;
}

/** One request to Chromium's DevTools HTTP endpoints (/json/...). */
export function devToolsRequest(
  endpoint: DevToolsEndpoint,
  path: string,
  method = "GET",
): Promise<{ status: number; contentType?: string; text: string }> {
  return new Promise((resolve, reject) => {
    const [hostname, port] = (endpoint.host ?? "").split(":");
    const req = http.request(
      {
        ...(endpoint.socketPath
          ? { socketPath: endpoint.socketPath }
          : { hostname, port: Number(port) }),
        path,
        method,
        // Chromium serves these only to a local Host (over TCP, the default
        // one is: it names the port, which Chromium puts in the URLs).
        ...(endpoint.socketPath ? { headers: { host: "127.0.0.1" } } : {}),
        timeout: 10_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > 4 * 1024 * 1024) req.destroy(Error("too large"));
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 502,
            contentType: res.headers["content-type"],
            text,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Whether a request did not come straight from a program in the project:
 * CoCalc's proxies (which reach any port in the project, for collaborators)
 * add X-Forwarded-For, and a web page's request carries its Origin.
 */
export function fromOutsideProject(req: http.IncomingMessage): boolean {
  const headers = req.headers;
  return (
    headers["x-forwarded-for"] != null ||
    headers["x-forwarded-host"] != null ||
    headers["forwarded"] != null ||
    headers["origin"] != null
  );
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

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 5;

export function clampZoom(value: unknown): number {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return 1;
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) * 100) / 100;
}

// The still frame once the page rests.  A zoomed-in page gets one even at
// Fast: its stream is at the page's (smaller) size, and soft when enlarged.
function restFrame(page: TabPage): { format: string; quality?: number } | null {
  return (
    QUALITY[page.quality].rest ??
    (page.zoom > 1 ? { format: "jpeg", quality: 80 } : null)
  );
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
// Only regular files inside the home directory, after resolving symlinks:
// never e.g. /run/secrets, or a link that points out of home.
export function resolveProjectFile(
  path: string,
  home: string = homedir(),
): string | null {
  try {
    const root = realpathSync(home);
    const real = realpathSync(isAbsolute(path) ? path : resolve(home, path));
    const inside = relative(root, real);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
