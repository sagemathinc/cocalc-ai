/**
 * Built-in agent actions on the shared browser's active tab, for agents
 * without a CDP client library (`cocalc project browser goto|eval|click|...`).
 * They go through the same CDP proxy as any other agent, so while the human
 * drives they wait until the human hands back.
 */
import { CdpClient } from "./cdp-client";
import { normalizeUrl } from "./server";

// Page actions may wait for the human to hand back.
const ACTION_TIMEOUT_MS = 30 * 60_000;

// Key name -> [code, windowsVirtualKeyCode, text]
const KEYS: Record<string, [string, number, string?]> = {
  Enter: ["Enter", 13, "\r"],
  Tab: ["Tab", 9, "\t"],
  Escape: ["Escape", 27],
  Backspace: ["Backspace", 8],
  Delete: ["Delete", 46],
  ArrowUp: ["ArrowUp", 38],
  ArrowDown: ["ArrowDown", 40],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36],
  End: ["End", 35],
  PageUp: ["PageUp", 33],
  PageDown: ["PageDown", 34],
  " ": ["Space", 32, " "],
};
export const SUPPORTED_KEYS = Object.keys(KEYS).map((k) =>
  k === " " ? "Space" : k,
);

export class SharedBrowserPage {
  private constructor(
    private readonly client: CdpClient,
    private readonly sessionId: string,
    readonly targetId: string,
  ) {}

  /** Attach to `targetId` (the tab shown to the human) or the first page. */
  static async open(
    cdp: string,
    targetId?: string | null,
  ): Promise<SharedBrowserPage> {
    const res = await fetch(`${cdp}/json/version`);
    const version = await res.json().catch(() => ({}));
    if (!res.ok || !version.webSocketDebuggerUrl)
      throw Error(
        version.error ?? `the browser is not available (${res.status})`,
      );
    const client = await CdpClient.connect(version.webSocketDebuggerUrl);
    try {
      const { targetInfos } = await client.send("Target.getTargets");
      const pages = (targetInfos as any[]).filter((t) => t.type === "page");
      const target =
        pages.find((t) => t.targetId === targetId) ?? pages[0] ?? null;
      if (!target) throw Error("the shared browser has no open tab");
      const { sessionId } = await client.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      return new SharedBrowserPage(client, sessionId, target.targetId);
    } catch (err) {
      client.close();
      throw err;
    }
  }

  close(): void {
    this.client.close();
  }

  private send<T = any>(method: string, params: object = {}): Promise<T> {
    return this.client.send<T>(
      method,
      params,
      this.sessionId,
      ACTION_TIMEOUT_MS,
    );
  }

  /** Evaluate an expression (awaiting promises); returns its JSON value. */
  async evaluate(expression: string): Promise<any> {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails) {
      const message =
        exceptionDetails.exception?.description ??
        exceptionDetails.exception?.value ??
        exceptionDetails.text;
      throw Error(`${message}`);
    }
    return result?.value;
  }

  async location(): Promise<{ url: string; title: string }> {
    return await this.evaluate("({url: location.href, title: document.title})");
  }

  async waitForLoad(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await this.evaluate("document.readyState")) === "complete") return;
      } catch {
        // The old document went away mid-navigation.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async goto(input: string, timeoutMs?: number) {
    const url = normalizeUrl(input);
    if (!url) throw Error(`not a web address: ${input}`);
    const { errorText } = await this.send("Page.navigate", { url });
    if (errorText) throw Error(`could not open ${url}: ${errorText}`);
    await this.waitForLoad(timeoutMs);
    return await this.location();
  }

  private async center(selector: string): Promise<{ x: number; y: number }> {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw Error(`no element matches ${selector}`);
    if (!box.w || !box.h) throw Error(`${selector} is not visible`);
    return box;
  }

  /** A real mouse click at the element's center. */
  async click(selector: string) {
    const { x, y } = await this.center(selector);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await this.waitForLoad(10_000);
    return await this.location();
  }

  /** Type text into the focused element, or `selector` after focusing it. */
  async type(text: string, selector?: string) {
    if (selector) {
      const found = await this.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        return true;
      })()`);
      if (!found) throw Error(`no element matches ${selector}`);
    }
    await this.send("Input.insertText", { text });
  }

  async press(name: string) {
    const key = name === "Space" ? " " : name;
    let entry = KEYS[key];
    if (!entry && key.length === 1)
      entry = [
        /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : "",
        /[a-z0-9]/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0,
        key,
      ];
    if (!entry)
      throw Error(
        `unknown key ${name}; use one character or one of ${SUPPORTED_KEYS.join(", ")}`,
      );
    const [code, windowsVirtualKeyCode, text] = entry;
    const common = { key, code, windowsVirtualKeyCode };
    await this.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      ...common,
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await this.waitForLoad(10_000);
    return await this.location();
  }

  /** The page's visible text, truncated to `max` characters. */
  async text(max = 20_000) {
    const { url, title, text } = await this.evaluate(
      "({url: location.href, title: document.title, text: document.body ? document.body.innerText : ''})",
    );
    const truncated = text.length > max;
    return {
      url,
      title,
      text: truncated ? text.slice(0, max) : text,
      ...(truncated ? { truncated: true, length: text.length } : {}),
    };
  }

  async screenshot(fullPage = false): Promise<Buffer> {
    let clip: object | undefined;
    if (fullPage) {
      const { cssContentSize } = await this.send("Page.getLayoutMetrics");
      clip = {
        x: 0,
        y: 0,
        width: Math.ceil(cssContentSize.width),
        height: Math.min(Math.ceil(cssContentSize.height), 16_384),
        scale: 1,
      };
    }
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip, captureBeyondViewport: true } : {}),
    });
    return Buffer.from(data, "base64");
  }
}
