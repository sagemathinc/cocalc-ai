/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The browser's screen: frames drawn on a canvas, and the human's mouse,
// keyboard and clipboard turned into the browser's input.  Plain DOM, like a
// terminal's; the React viewer around it draws everything else.

import type {
  SharedBrowserState,
  ViewerMessage,
  ViewQuality,
} from "@cocalc/util/shared-browser-protocol";

import { isAccel, isApple, keyMessage, zoomShortcut } from "./input";

export interface ScreenHost {
  send(msg: ViewerMessage): void;
  state(): SharedBrowserState | undefined;
  // The human drives (and the browser is not a preview of their computer).
  human(): boolean;
  quality(): ViewQuality;
  // The human used the browser without driving: say why, with the way out.
  notDriving(): void;
  zoomStep(direction: -1 | 0 | 1): void;
  // Where the pointer last was (for the <select> popup).
  pointer(p: { x: number; y: number }): void;
}

const BUTTONS = ["left", "middle", "right"] as const;

export class BrowserScreen {
  private readonly ctx: CanvasRenderingContext2D;
  frame: ImageBitmap | null = null;
  private selection = "";
  // A copy in progress through the keyboard's field (see copy()).
  private copyText: string | null = null;
  // What this viewer last put on the clipboard, so the page's own copy of
  // the same text is not offered again.
  lastCopy = { text: "", at: 0 };
  private composing = false;
  private visible: boolean | null = null;
  private lastSize = "";
  private sizeTimer?: ReturnType<typeof setTimeout>;
  private moveQueued: MouseEvent | null = null;
  private pinch = 0;
  private readonly apple = isApple();
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly stage: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly keys: HTMLTextAreaElement,
    private readonly host: ScreenHost,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.listenInput();
    const resize = new ResizeObserver(() => {
      this.updateVisible();
      this.sendSize(false);
    });
    resize.observe(stage);
    this.cleanups.push(() => resize.disconnect());
    this.on(document, "visibilitychange", () => this.updateVisible());
    this.watchPixelRatio();
  }

  destroy(): void {
    clearTimeout(this.sizeTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.frame?.close?.();
    this.frame = null;
  }

  /** (Re)connected: tell the browser how big and whether visible. */
  connected(): void {
    this.visible = null;
    this.updateVisible();
    this.sendSize(true);
  }

  private on(
    target: EventTarget,
    type: string,
    handler: (e: any) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    this.cleanups.push(() =>
      target.removeEventListener(type, handler, options),
    );
  }

  // --- the picture ---------------------------------------------------------

  drawFrame(bitmap: ImageBitmap): void {
    // Redrawing the current frame (e.g. on resize) must not close it first.
    if (this.frame && this.frame !== bitmap) this.frame.close?.();
    this.frame = bitmap;
    this.canvas.classList.add("cc-sbv-shown");
    const { width, height } = this.canvas;
    this.ctx.fillStyle = getComputedStyle(this.stage).backgroundColor;
    this.ctx.fillRect(0, 0, width, height);
    // Frames are rendered at the viewport size, which follows this canvas.
    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    // Frames come at the canvas's device pixels: draw them 1:1 when they fit.
    this.ctx.imageSmoothingEnabled = Math.abs(scale - 1) > 0.01;
    this.ctx.imageSmoothingQuality = "high";
    this.ctx.drawImage(
      bitmap,
      0,
      0,
      bitmap.width * scale,
      bitmap.height * scale,
    );
  }

  clear(): void {
    this.frame?.close?.();
    this.frame = null;
    this.ctx.fillStyle = getComputedStyle(this.stage).backgroundColor;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** A small picture of the screen (a JPEG data URL), or null. */
  picture(maxWidth = 640): string | null {
    const frame = this.frame;
    if (!frame) return null;
    try {
      const width = Math.min(maxWidth, frame.width);
      const height = Math.round((frame.height * width) / frame.width);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.drawImage(frame, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", 0.6);
    } catch {
      return null;
    }
  }

  // --- size and visibility -------------------------------------------------

  private tooSmall(): boolean {
    const r = this.stage.getBoundingClientRect();
    return r.width < 40 || r.height < 40;
  }

  // A hidden view (another tab or frame in front, a background browser tab)
  // keeps its last frame and must not resize the page to nothing.
  private updateVisible(): void {
    const visible = !document.hidden && !this.tooSmall();
    if (visible === this.visible) return;
    this.visible = visible;
    this.host.send({ type: "visible", visible });
    if (visible) this.sendSize(true);
  }

  sendSize(force: boolean): void {
    if (this.tooSmall()) {
      this.updateVisible();
      return;
    }
    const r = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    if (this.frame) this.drawFrame(this.frame);
    const quality = this.host.quality();
    const key = `${Math.round(r.width)}x${Math.round(r.height)}@${dpr}${quality}`;
    if (!force && key === this.lastSize) return;
    this.lastSize = key;
    clearTimeout(this.sizeTimer);
    this.sizeTimer = setTimeout(
      () =>
        this.host.send({
          type: "resize",
          width: Math.round(r.width),
          height: Math.round(r.height),
          quality,
        }),
      150,
    );
  }

  // Moving the window to a screen with another pixel ratio.
  private watchPixelRatio(): void {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const changed = () => {
      this.sendSize(true);
      this.watchPixelRatio();
    };
    mq.addEventListener("change", changed, { once: true });
    this.cleanups.push(() => mq.removeEventListener("change", changed));
  }

  // --- mouse ---------------------------------------------------------------

  private point(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.host.pointer(p);
    const state = this.host.state();
    const vw = state ? state.viewport.width : r.width;
    const vh = state ? state.viewport.height : r.height;
    const scale = Math.min(r.width / vw, r.height / vh) || 1;
    return { x: p.x / scale, y: p.y / scale };
  }

  private mouse(
    event: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel",
    e: MouseEvent,
    extra: Partial<Extract<ViewerMessage, { type: "mouse" }>> = {},
  ): void {
    if (!this.host.human()) {
      if (event === "mousePressed") this.host.notDriving();
      return;
    }
    const p = this.point(e);
    this.host.send({
      type: "mouse",
      event,
      x: p.x,
      y: p.y,
      modifiers:
        (e.altKey ? 1 : 0) |
        (e.ctrlKey || (this.apple && e.metaKey) ? 2 : 0) |
        (e.metaKey && !this.apple ? 4 : 0) |
        (e.shiftKey ? 8 : 0),
      buttons: e.buttons,
      ...extra,
    });
  }

  private listenInput(): void {
    const canvas = this.canvas;
    this.on(canvas, "mousedown", (e: MouseEvent) => {
      this.focus();
      // A click anywhere closes a <select> popup.
      if (this.host.state()?.select)
        this.host.send({ type: "select", index: -1 });
      this.mouse("mousePressed", e, {
        button: BUTTONS[e.button] ?? "left",
        clickCount: e.detail || 1,
      });
      e.preventDefault();
    });
    this.on(canvas, "mouseup", (e: MouseEvent) =>
      this.mouse("mouseReleased", e, {
        button: BUTTONS[e.button] ?? "left",
        clickCount: e.detail || 1,
      }),
    );
    this.on(canvas, "mousemove", (e: MouseEvent) => {
      if (!this.host.human()) return;
      if (this.moveQueued) {
        this.moveQueued = e;
        return;
      }
      this.moveQueued = e;
      requestAnimationFrame(() => {
        const ev = this.moveQueued;
        this.moveQueued = null;
        if (ev)
          this.mouse("mouseMoved", ev, {
            button: ev.buttons & 1 ? "left" : "none",
          });
      });
    });
    // Ctrl+wheel zooms, as in a browser; so does a trackpad pinch (which
    // arrives as Ctrl+wheel).
    this.on(
      canvas,
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        if (e.ctrlKey) {
          this.pinch += e.deltaY;
          if (Math.abs(this.pinch) >= 40) {
            this.host.zoomStep(this.pinch < 0 ? 1 : -1);
            this.pinch = 0;
          }
          return;
        }
        this.mouse("mouseWheel", e, { deltaX: e.deltaX, deltaY: e.deltaY });
      },
      { passive: false },
    );
    this.on(canvas, "contextmenu", (e) => e.preventDefault());

    // --- keyboard: a hidden text field takes it.  A text field gets paste,
    // copy and input-method events everywhere (iPad included); a canvas does
    // not.  It holds the page's selection, selected, so a copy copies that.
    const keys = this.keys;
    // The keys are the browser's, not CoCalc's shortcuts'.
    for (const type of ["keydown", "keyup", "keypress"])
      this.on(keys, type, (e: KeyboardEvent) => e.stopPropagation());
    this.on(keys, "keydown", (e: KeyboardEvent) => this.key("keyDown", e));
    this.on(keys, "keyup", (e: KeyboardEvent) => this.key("keyUp", e));
    this.on(keys, "compositionstart", () => (this.composing = true));
    this.on(keys, "compositionend", (e: CompositionEvent) => {
      this.composing = false;
      if (this.host.human() && e.data)
        this.host.send({ type: "text", text: e.data });
      this.mirror();
    });
    // Text that came without a key (dictation, a virtual keyboard).
    this.on(keys, "input", (e: InputEvent) => {
      if (this.composing) return;
      if (this.host.human() && e.inputType === "insertText" && e.data)
        this.host.send({ type: "text", text: e.data });
      this.mirror();
    });
    this.on(document, "paste", (e: ClipboardEvent) => {
      if (document.activeElement !== keys || !this.host.human()) return;
      e.preventDefault();
      const text = e.clipboardData?.getData("text") ?? "";
      if (text) this.host.send({ type: "text", text });
    });
    // Copy and cut take the page's selection, driving or not.
    for (const type of ["copy", "cut"])
      this.on(document, type, (e: ClipboardEvent) => {
        if (document.activeElement !== keys) return;
        e.preventDefault();
        const text = this.copyText ?? this.selection;
        if (!text) return;
        e.clipboardData?.setData("text/plain", text);
        this.lastCopy = { text, at: Date.now() };
      });
  }

  private key(event: "keyDown" | "keyUp", e: KeyboardEvent): void {
    // Page zoom, as in a browser (watching is enough).
    const zoom = zoomShortcut(e, this.apple);
    if (zoom !== undefined) {
      e.preventDefault();
      if (event === "keyDown") this.host.zoomStep(zoom);
      return;
    }
    const shortcut = isAccel(e, this.apple) ? e.key.toLowerCase() : "";
    // Copy and cut: the system's copy event takes the page's selection (see
    // above), driving or not; the page gets the keys too, for its own copy
    // handlers (and so a cut deletes there).
    if (shortcut === "c" || shortcut === "x") {
      if (this.host.human()) this.host.send(keyMessage(event, e, this.apple));
      return;
    }
    // Paste arrives as a paste event.
    if (shortcut === "v") return;
    if (!this.host.human()) {
      if (event === "keyDown") this.host.notDriving();
      return;
    }
    // An input method or a virtual keyboard: the text arrives as input.
    if (e.isComposing || e.key === "Unidentified" || e.keyCode === 229) return;
    e.preventDefault();
    this.host.send(keyMessage(event, e, this.apple));
  }

  // --- clipboard -------------------------------------------------------------

  focus(): void {
    this.keys.focus({ preventScroll: true });
    this.mirror();
  }

  /** What is selected in the page. */
  setSelection(text: string): void {
    this.selection = text;
    this.mirror();
  }

  private mirror(): void {
    if (this.composing) return;
    if (this.keys.value !== this.selection) this.keys.value = this.selection;
    if (document.activeElement === this.keys) this.keys.select();
  }

  /** Put text on the clipboard (within a click or a key press). */
  copy(text: string): Promise<void> {
    this.lastCopy = { text, at: Date.now() };
    const fallback = () => {
      this.copyText = text;
      this.keys.value = text;
      this.keys.focus({ preventScroll: true });
      this.keys.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {}
      this.copyText = null;
      this.mirror();
      return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
    };
    if (navigator.clipboard?.writeText)
      return navigator.clipboard.writeText(text).catch(fallback);
    return fallback();
  }
}
