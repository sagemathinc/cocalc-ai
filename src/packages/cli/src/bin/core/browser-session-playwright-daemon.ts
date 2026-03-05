#!/usr/bin/env node

/*
Detached Playwright-backed browser session daemon.

This process is launched by `cocalc browser session spawn` and kept alive in
the background until `cocalc browser session destroy` sends SIGTERM/SIGINT.
*/

import {
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

type SpawnCookie = {
  name: string;
  value: string;
  url: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
};

type SpawnDaemonConfig = {
  spawn_id: string;
  state_file: string;
  target_url: string;
  headless?: boolean;
  timeout_ms?: number;
  executable_path?: string;
  session_name?: string;
  cookies?: SpawnCookie[];
};

type SpawnDaemonState = {
  spawn_id: string;
  pid: number;
  browser_pid?: number;
  status: "starting" | "ready" | "stopping" | "stopped" | "failed";
  target_url: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  stopped_at?: string;
  ready_at?: string;
  reason?: string;
  error?: string;
  page_url?: string;
  executable_path?: string;
  session_name?: string;
  ipc_dir?: string;
};

type DaemonRequest = {
  request_id: string;
  action: "screenshot";
  selector?: string;
  wait_for_idle_ms?: number;
  timeout_ms?: number;
  full_page?: boolean;
  viewport_width?: number;
  viewport_height?: number;
};

type DaemonResponse =
  | {
      ok: true;
      request_id: string;
      result: Record<string, unknown>;
    }
  | {
      ok: false;
      request_id: string;
      error: string;
    };

const IPC_POLL_MS = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeError(err: unknown): string {
  return `${err instanceof Error ? err.stack || err.message : err}`;
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeState(
  file: string,
  current: SpawnDaemonState | undefined,
  patch: Partial<SpawnDaemonState>,
): SpawnDaemonState {
  const timestamp = nowIso();
  const next: SpawnDaemonState = {
    ...(current ?? ({} as SpawnDaemonState)),
    ...patch,
    updated_at: timestamp,
  };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  ensureParentDir(file);
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
  renameSync(tmp, file);
  return next;
}

function readConfig(configPath: string): SpawnDaemonConfig {
  const raw = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid daemon config JSON: ${normalizeError(err)}`);
  } finally {
    try {
      unlinkSync(configPath);
    } catch {
      // best-effort cleanup
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("daemon config must be an object");
  }
  const row = parsed as Record<string, unknown>;
  const spawn_id = `${row.spawn_id ?? ""}`.trim();
  const state_file = `${row.state_file ?? ""}`.trim();
  const target_url = `${row.target_url ?? ""}`.trim();
  if (!spawn_id) throw new Error("daemon config missing spawn_id");
  if (!state_file) throw new Error("daemon config missing state_file");
  if (!target_url) throw new Error("daemon config missing target_url");
  const timeoutMsRaw = Number(row.timeout_ms ?? 30_000);
  const timeout_ms =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.floor(timeoutMsRaw)
      : 30_000;
  const headless = row.headless === true;
  const executable_path = `${row.executable_path ?? ""}`.trim() || undefined;
  const session_name = `${row.session_name ?? ""}`.trim() || undefined;
  const cookies = Array.isArray(row.cookies)
    ? (row.cookies.filter(
        (x) =>
          x &&
          typeof x === "object" &&
          `${(x as any).name ?? ""}`.trim() &&
          `${(x as any).value ?? ""}`.length >= 0 &&
          `${(x as any).url ?? ""}`.trim(),
      ) as SpawnCookie[])
    : undefined;
  return {
    spawn_id,
    state_file,
    target_url,
    timeout_ms,
    headless,
    executable_path,
    session_name,
    cookies,
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  ensureParentDir(path);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
  renameSync(tmp, path);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

function parsePngDimensions(
  pngBuffer: Buffer,
): { width: number; height: number } | undefined {
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length < 24) return undefined;
  // PNG IHDR width/height are bytes 16..23 (big-endian).
  const sig = pngBuffer.slice(0, 8);
  const expectedSig = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (!sig.equals(expectedSig)) return undefined;
  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return { width, height };
}

async function waitForDomIdle(page: any, waitForIdleMs: number): Promise<boolean> {
  const idleMs =
    Number.isFinite(waitForIdleMs) && waitForIdleMs > 0
      ? Math.floor(waitForIdleMs)
      : 0;
  if (!idleMs) return false;
  return await page.evaluate(async (requestedIdleMs: number) => {
    const maxWaitMs = Math.max(
      1000,
      Math.min(30000, Math.floor(requestedIdleMs * 20)),
    );
    const timedOut = await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let maxTimer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (maxedOut: boolean) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (maxTimer) clearTimeout(maxTimer);
        observer.disconnect();
        resolve(!!maxedOut);
      };
      const schedule = () => {
        if (done) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish(false), requestedIdleMs);
      };
      const root = document.documentElement || document.body;
      const observer = new MutationObserver(() => {
        schedule();
      });
      if (root) {
        observer.observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
      maxTimer = setTimeout(() => finish(true), maxWaitMs);
      schedule();
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return timedOut;
  }, idleMs);
}

function getIpcDir(config: SpawnDaemonConfig): string {
  return join(dirname(config.state_file), `${config.spawn_id}.ipc`);
}

function listRequestFiles(ipcDir: string): string[] {
  if (!existsSync(ipcDir)) return [];
  return readdirSync(ipcDir)
    .filter((name) => name.endsWith(".request.json"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(ipcDir, name));
}

function responsePathForRequest(requestPath: string): string {
  if (requestPath.endsWith(".request.json")) {
    return `${requestPath.slice(0, -".request.json".length)}.response.json`;
  }
  return `${requestPath}.response.json`;
}

async function main(): Promise<void> {
  const configPath = `${process.argv[2] ?? ""}`.trim();
  if (!configPath) {
    throw new Error("usage: browser-session-playwright-daemon <config.json>");
  }
  const config = readConfig(configPath);
  const ipcDir = getIpcDir(config);
  mkdirSync(ipcDir, { recursive: true });
  let state: SpawnDaemonState | undefined = undefined;
  state = writeState(config.state_file, state, {
    spawn_id: config.spawn_id,
    pid: process.pid,
    status: "starting",
    target_url: config.target_url,
    created_at: nowIso(),
    started_at: nowIso(),
    ...(config.executable_path ? { executable_path: config.executable_path } : {}),
    ...(config.session_name ? { session_name: config.session_name } : {}),
    ipc_dir: ipcDir,
  });

  const playwright = (await import("playwright-core")) as any;
  const launchOpts: Record<string, unknown> = {
    headless: !!config.headless,
    timeout: config.timeout_ms,
    args: [
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  };
  if (config.executable_path) {
    launchOpts.executablePath = config.executable_path;
  }
  const browser = await playwright.chromium.launch(launchOpts);
  const browserProcessPid = Number(browser?.process?.()?.pid ?? 0);
  const context = await browser.newContext();
  if (config.cookies?.length) {
    await context.addCookies(config.cookies);
  }
  const page = await context.newPage();
  await page.goto(config.target_url, {
    waitUntil: "domcontentloaded",
    timeout: config.timeout_ms,
  });
  if (config.session_name) {
    try {
      await page.evaluate((sessionName: string) => {
        document.title = sessionName;
      }, config.session_name);
    } catch {
      // best-effort; title is metadata only
    }
  }
  state = writeState(config.state_file, state, {
    status: "ready",
    ready_at: nowIso(),
    page_url: page.url(),
    ...(browserProcessPid > 0 ? { browser_pid: browserProcessPid } : {}),
    ipc_dir: ipcDir,
  });

  const handleRequest = async (requestPath: string): Promise<void> => {
    const responsePath = responsePathForRequest(requestPath);
    let requestId = "";
    try {
      const request = readJson(requestPath) as DaemonRequest;
      requestId = `${request?.request_id ?? ""}`.trim();
      if (!requestId) throw new Error("missing request_id");
      if (`${request?.action ?? ""}`.trim() !== "screenshot") {
        throw new Error(`unsupported action '${request?.action ?? ""}'`);
      }
      const selector = `${request.selector ?? "body"}`.trim() || "body";
      const timeoutMsRaw = Number(request.timeout_ms ?? config.timeout_ms ?? 30_000);
      const timeoutMs =
        Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
          ? Math.floor(timeoutMsRaw)
          : 30_000;
      const waitForIdleRaw = Number(request.wait_for_idle_ms ?? 0);
      const waitForIdleMs =
        Number.isFinite(waitForIdleRaw) && waitForIdleRaw > 0
          ? Math.floor(waitForIdleRaw)
          : 0;
      const fullPage = request.full_page === true;
      const viewportWidthRaw = Number(request.viewport_width ?? 0);
      const viewportHeightRaw = Number(request.viewport_height ?? 0);
      const viewportWidth =
        Number.isFinite(viewportWidthRaw) && viewportWidthRaw > 0
          ? Math.floor(viewportWidthRaw)
          : undefined;
      const viewportHeight =
        Number.isFinite(viewportHeightRaw) && viewportHeightRaw > 0
          ? Math.floor(viewportHeightRaw)
          : undefined;
      if ((viewportWidth == null) !== (viewportHeight == null)) {
        throw new Error("viewport_width and viewport_height must be provided together");
      }
      if (viewportWidth != null && viewportHeight != null) {
        await page.setViewportSize({
          width: viewportWidth,
          height: viewportHeight,
        });
      }
      const waitForIdleTimedOut = await waitForDomIdle(page, waitForIdleMs);
      const locator = page.locator(selector).first();
      if (!fullPage) {
        await locator.waitFor({ state: "visible", timeout: timeoutMs });
      }
      const captureMeta = (await page.evaluate((sel) => {
        const root = document.querySelector(sel);
        if (!root) {
          throw new Error(`selector did not match any element: ${sel}`);
        }
        const rect = root.getBoundingClientRect();
        return {
          page_url: location.href,
          selector: sel,
          selector_rect_css: {
            left: Number(rect.left || 0),
            top: Number(rect.top || 0),
            width: Number(rect.width || 0),
            height: Number(rect.height || 0),
          },
          viewport_css: {
            width: Number(window.innerWidth || 0),
            height: Number(window.innerHeight || 0),
          },
          device_pixel_ratio: Number(window.devicePixelRatio || 1),
          scroll_x: Number(window.scrollX || window.pageXOffset || 0),
          scroll_y: Number(window.scrollY || window.pageYOffset || 0),
        };
      }, selector)) as {
        page_url: string;
        selector: string;
        selector_rect_css: { left: number; top: number; width: number; height: number };
        viewport_css: { width: number; height: number };
        device_pixel_ratio: number;
        scroll_x: number;
        scroll_y: number;
      };
      const pngBuffer = (await (fullPage
        ? page.screenshot({
            type: "png",
            timeout: timeoutMs,
            fullPage: true,
          })
        : locator.screenshot({
            type: "png",
            timeout: timeoutMs,
          }))) as Buffer;
      const dims = parsePngDimensions(pngBuffer);
      const captured_at = nowIso();
      const captureScale = Number(captureMeta.device_pixel_ratio || 1);
      const result = {
        ok: true,
        selector,
        full_page: fullPage,
        width: Number(dims?.width ?? 0),
        height: Number(dims?.height ?? 0),
        page_url: captureMeta.page_url,
        captured_at,
        capture_scale: captureScale,
        device_pixel_ratio: captureMeta.device_pixel_ratio,
        scroll_x: captureMeta.scroll_x,
        scroll_y: captureMeta.scroll_y,
        selector_rect_css: captureMeta.selector_rect_css,
        viewport_css: captureMeta.viewport_css,
        screenshot_meta: {
          page_url: captureMeta.page_url,
          captured_at,
          selector,
          image_width: Number(dims?.width ?? 0),
          image_height: Number(dims?.height ?? 0),
          capture_scale: captureScale,
          device_pixel_ratio: captureMeta.device_pixel_ratio,
          scroll_x: captureMeta.scroll_x,
          scroll_y: captureMeta.scroll_y,
          selector_rect_css: captureMeta.selector_rect_css,
          viewport_css: captureMeta.viewport_css,
        },
        wait_for_idle_ms: waitForIdleMs,
        wait_for_idle_timed_out: waitForIdleTimedOut,
        png_data_url: `data:image/png;base64,${pngBuffer.toString("base64")}`,
      };
      const response: DaemonResponse = {
        ok: true,
        request_id: requestId,
        result,
      };
      writeJsonAtomic(responsePath, response);
    } catch (err) {
      const response: DaemonResponse = {
        ok: false,
        request_id: requestId || "unknown",
        error: normalizeError(err),
      };
      writeJsonAtomic(responsePath, response);
    } finally {
      safeUnlink(requestPath);
    }
  };

  let requestLoopBusy = false;
  const pollRequests = async (): Promise<void> => {
    if (requestLoopBusy || stopping) return;
    requestLoopBusy = true;
    try {
      const requestFiles = listRequestFiles(ipcDir);
      for (const requestFile of requestFiles) {
        await handleRequest(requestFile);
      }
    } finally {
      requestLoopBusy = false;
    }
  };

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    state = writeState(config.state_file, state, {
      status: "stopping",
      reason,
      stopped_at: nowIso(),
    });
    try {
      await context.close();
    } catch {
      // ignore shutdown races
    }
    try {
      await browser.close();
    } catch {
      // ignore shutdown races
    }
    writeState(config.state_file, state, {
      status: "stopped",
      reason,
      stopped_at: nowIso(),
    });
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void stop("SIGTERM");
  });
  process.on("SIGINT", () => {
    void stop("SIGINT");
  });
  process.on("SIGHUP", () => {
    void stop("SIGHUP");
  });
  process.on("uncaughtException", (err) => {
    writeState(config.state_file, state, {
      status: "failed",
      error: normalizeError(err),
      stopped_at: nowIso(),
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    writeState(config.state_file, state, {
      status: "failed",
      error: normalizeError(err),
      stopped_at: nowIso(),
    });
    process.exit(1);
  });

  setInterval(() => {
    void pollRequests();
  }, IPC_POLL_MS);
}

void main().catch((err) => {
  process.stderr.write(`${normalizeError(err)}\n`);
  process.exit(1);
});
