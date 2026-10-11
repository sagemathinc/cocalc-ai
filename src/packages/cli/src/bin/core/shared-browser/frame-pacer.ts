/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Frame pacing.  Chromium renders an animated page 60 times a second for a
screencast, in software: about a core for one watched tab (measured: an
animated canvas at 1000x700, 0.77 cores at 60 fps).  Started with
--enable-begin-frame-control (chrome-headless-shell), it renders a tab only
when asked (HeadlessExperimental.beginFrame), every tab, popups too.  So we
ask: often for a tab someone watches or an agent is using (0.46 cores at
30 fps), seldom for the others (0.01 at 4 fps), which keeps their pages
running (requestAnimationFrame, screenshots) without drawing for nobody.  A
page busy in JavaScript holds its frame up, and gets no more until it is
done.

Full Chrome ignores the flag and has no beginFrame: the first answer says so,
and the pacer stops for good.
*/

export const WATCHED_FPS = 30;
export const BACKGROUND_FPS = 4;
// An agent's command keeps its tab at the watched rate this long (actions
// wait for animation frames, screenshots for a frame).
export const BUSY_MS = 2000;

type Send = (
  method: string,
  params: object,
  sessionId?: string,
) => Promise<any>;

interface PacedTab {
  session: string | null;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  busyUntil: number;
  closed: boolean;
}

export class FramePacer {
  private tabs = new Map<string, PacedTab>();
  // null: not known yet (no answer to beginFrame so far).
  supported: boolean | null = null;

  constructor(
    private readonly options: {
      send: Send;
      // Whether someone can see this tab now.
      watched: (targetId: string) => boolean;
      log?: (message: string) => void;
    },
  ) {}

  add(targetId: string): void {
    if (this.supported === false || this.tabs.has(targetId)) return;
    const tab: PacedTab = {
      session: null,
      timer: null,
      inFlight: false,
      busyUntil: 0,
      closed: false,
    };
    this.tabs.set(targetId, tab);
    this.options
      .send("Target.attachToTarget", { targetId, flatten: true })
      .then(({ sessionId }) => {
        if (tab.closed) {
          void this.options
            .send("Target.detachFromTarget", { sessionId })
            .catch(() => {});
          return;
        }
        tab.session = sessionId;
        this.tick(targetId, tab);
      })
      .catch(() => this.remove(targetId));
  }

  remove(targetId: string): void {
    const tab = this.tabs.get(targetId);
    if (!tab) return;
    this.tabs.delete(targetId);
    tab.closed = true;
    if (tab.timer) clearTimeout(tab.timer);
    if (tab.session)
      void this.options
        .send("Target.detachFromTarget", { sessionId: tab.session })
        .catch(() => {});
  }

  /** Someone is using this tab: frames at the watched rate for a while. */
  busy(targetId: string | null | undefined): void {
    if (!targetId) return;
    const tab = this.tabs.get(targetId);
    if (!tab) return;
    const slow = Date.now() >= tab.busyUntil && !this.options.watched(targetId);
    tab.busyUntil = Date.now() + BUSY_MS;
    // It was waiting for its next slow frame: one now.
    if (slow) this.schedule(targetId, tab, 0);
  }

  /** The rate changed (a viewer came or left): apply it now. */
  update(targetId: string): void {
    const tab = this.tabs.get(targetId);
    if (tab) this.schedule(targetId, tab, 0);
  }

  close(): void {
    for (const targetId of [...this.tabs.keys()]) this.remove(targetId);
  }

  private fps(targetId: string, tab: PacedTab): number {
    return this.options.watched(targetId) || Date.now() < tab.busyUntil
      ? WATCHED_FPS
      : BACKGROUND_FPS;
  }

  private schedule(targetId: string, tab: PacedTab, ms: number): void {
    if (tab.closed || !tab.session) return;
    if (tab.timer) clearTimeout(tab.timer);
    tab.timer = setTimeout(() => this.tick(targetId, tab), ms);
  }

  private tick(targetId: string, tab: PacedTab): void {
    tab.timer = null;
    if (tab.closed || !tab.session || this.supported === false) return;
    // The last frame is not done (the page is busy): it schedules the next.
    if (tab.inFlight) return;
    tab.inFlight = true;
    const started = Date.now();
    this.options
      .send("HeadlessExperimental.beginFrame", {}, tab.session)
      .then(() => {
        this.supported = true;
      })
      .catch((err) => {
        const message = `${err?.message ?? err}`;
        // Full Chrome ("wasn't found"), or started without the flags.
        if (
          this.supported !== true &&
          /wasn't found|not supported|only supported/i.test(message)
        ) {
          this.supported = false;
          this.options.log?.(
            `frames are not paced (this Chromium renders by itself): ${message}`,
          );
          this.close();
        }
        // Otherwise the tab is closing or between pages: keep going.
      })
      .finally(() => {
        tab.inFlight = false;
        const interval = 1000 / this.fps(targetId, tab);
        this.schedule(
          targetId,
          tab,
          Math.max(0, interval - (Date.now() - started)),
        );
      });
  }
}
