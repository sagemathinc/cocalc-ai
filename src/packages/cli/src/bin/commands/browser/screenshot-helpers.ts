/*
Screenshot helpers for browser command workflows.
*/

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserScreenshotMetadata } from "@cocalc/conat/service/browser-session";
import { resolveSpawnIpcDir, resolveSpawnStateByBrowserId } from "./spawn-state";
import type {
  SpawnStateRecord,
  SpawnedScreenshotRequest,
  SpawnedScreenshotResponse,
} from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readScreenshotMeta(
  metaFile: string | undefined,
): Promise<BrowserScreenshotMetadata | undefined> {
  const clean = `${metaFile ?? ""}`.trim();
  if (!clean) return undefined;
  const raw = await readFile(clean, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in screenshot meta file '${clean}': ${err}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`screenshot meta file '${clean}' must contain a JSON object`);
  }
  return parsed as BrowserScreenshotMetadata;
}

export function browserScreenshotDomScript({
  selector,
  scale,
  waitForIdleMs,
}: {
  selector: string;
  scale: number;
  waitForIdleMs: number;
}): string {
  return `
const selector = ${JSON.stringify(selector)};
const scale = ${JSON.stringify(scale)};
const waitForIdleMs = ${JSON.stringify(waitForIdleMs)};
const libraryUrls = [
  "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",
  "https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js",
];
const loadScript = async (url) => {
  await new Promise((resolve, reject) => {
    const existing = Array.from(document.querySelectorAll("script")).find(
      (s) => s.src === url,
    );
    if (existing && (window).html2canvas) {
      resolve(undefined);
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    const timer = setTimeout(
      () => reject(new Error(\`timed out loading \${url}\`)),
      15000,
    );
    script.onload = () => resolve(undefined);
    script.onerror = () => reject(new Error(\`failed to load \${url}\`));
    script.onload = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error(\`failed to load \${url}\`));
    };
    document.head.appendChild(script);
  });
};
if (!(window).html2canvas) {
  let loaded = false;
  let lastErr = undefined;
  for (const url of libraryUrls) {
    try {
      await loadScript(url);
      if ((window).html2canvas) {
        loaded = true;
        break;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (!loaded || !(window).html2canvas) {
    const reason = lastErr ? \`: \${lastErr}\` : "";
    throw new Error(
      \`html2canvas is unavailable and could not be loaded from CDN\${reason}; try 'cocalc browser screenshot --renderer native --headless --use --timeout 2m'\`,
    );
  }
}
const el = document.querySelector(selector);
if (!el) {
  throw new Error(\`selector did not match any element: \${selector}\`);
}
const html2canvas = (window).html2canvas;
if (waitForIdleMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, waitForIdleMs));
}
const canvas = await html2canvas(el, {
  scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  useCORS: true,
  backgroundColor: null,
});
const rect = el.getBoundingClientRect();
const viewport_css = {
  width: Number(window.innerWidth || document.documentElement?.clientWidth || 0),
  height: Number(window.innerHeight || document.documentElement?.clientHeight || 0),
};
const selector_rect_css = {
  left: Number(rect.left),
  top: Number(rect.top),
  width: Number(rect.width),
  height: Number(rect.height),
};
const png_data_url = canvas.toDataURL("image/png");
return {
  page_url: location.href,
  captured_at: new Date().toISOString(),
  selector,
  screenshot_meta: {
    page_url: location.href,
    captured_at: new Date().toISOString(),
    selector,
    image_width: Number(canvas.width || 0),
    image_height: Number(canvas.height || 0),
    capture_scale:
      Number(selector_rect_css.width) > 0
        ? Number(canvas.width || 0) / Number(selector_rect_css.width)
        : undefined,
    device_pixel_ratio: Number(window.devicePixelRatio || 1),
    scroll_x: Number(window.scrollX || window.pageXOffset || 0),
    scroll_y: Number(window.scrollY || window.pageYOffset || 0),
    selector_rect_css,
    viewport_css,
  },
  png_data_url,
};
`.trim();
}

export function browserScreenshotMediaScript({
  selector,
  waitForIdleMs,
}: {
  selector: string;
  waitForIdleMs: number;
}): string {
  return `
const selector = ${JSON.stringify(selector)};
const waitForIdleMs = ${JSON.stringify(waitForIdleMs)};
const el = document.querySelector(selector);
if (!el) {
  throw new Error(\`selector did not match any element: \${selector}\`);
}
const rect = el.getBoundingClientRect();
const viewport_css = {
  width: Number(window.innerWidth || document.documentElement?.clientWidth || 0),
  height: Number(window.innerHeight || document.documentElement?.clientHeight || 0),
};
const selector_rect_css = {
  left: Number(rect.left),
  top: Number(rect.top),
  width: Number(rect.width),
  height: Number(rect.height),
};
if (!Number.isFinite(selector_rect_css.width) || selector_rect_css.width <= 0 ||
    !Number.isFinite(selector_rect_css.height) || selector_rect_css.height <= 0) {
  throw new Error(\`selector has invalid bounds: \${selector}\`);
}
let wait_for_idle_timed_out = false;
const waitForIdle = async () => {
  if (!(waitForIdleMs > 0)) return;
  const promise = (window).requestIdleCallback
    ? new Promise((resolve) => {
        try {
          const timeout = Math.max(1, Math.floor(waitForIdleMs));
          (window).requestIdleCallback(() => resolve(undefined), { timeout });
        } catch {
          setTimeout(() => resolve(undefined), Math.max(1, Math.floor(waitForIdleMs)));
        }
      })
    : new Promise((resolve) =>
        setTimeout(() => resolve(undefined), Math.max(1, Math.floor(waitForIdleMs))),
      );
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => {
      wait_for_idle_timed_out = true;
      resolve(undefined);
    }, Math.max(50, Math.floor(waitForIdleMs * 1.5))),
  );
  await Promise.race([promise, timeoutPromise]);
};
await waitForIdle();
let stream;
try {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices || !mediaDevices.getDisplayMedia) {
    throw new Error("getDisplayMedia is unavailable in this browser/session");
  }
  stream = await mediaDevices.getDisplayMedia({ video: true, audio: false });
  const videoTrack = stream.getVideoTracks?.()[0];
  if (!videoTrack) {
    throw new Error("no video track returned from getDisplayMedia");
  }
  const video = document.createElement("video");
  video.style.position = "fixed";
  video.style.left = "-99999px";
  video.style.top = "-99999px";
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  document.body.appendChild(video);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for display stream")), 15000);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    video.onerror = () => {
      clearTimeout(timer);
      reject(new Error("video failed to load metadata"));
    };
    video.play().catch(reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const width = Math.max(1, Math.floor(selector_rect_css.width));
  const height = Math.max(1, Math.floor(selector_rect_css.height));
  const dpr = Number(window.devicePixelRatio || 1) || 1;
  const sx = Math.max(0, Number(selector_rect_css.left + window.scrollX));
  const sy = Math.max(0, Number(selector_rect_css.top + window.scrollY));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("failed to create canvas context");
  ctx.scale(dpr, dpr);
  ctx.drawImage(
    video,
    sx,
    sy,
    width,
    height,
    0,
    0,
    width,
    height,
  );
  const png_data_url = canvas.toDataURL("image/png");
  try {
    video.pause();
    video.srcObject = null;
    video.remove();
  } catch {}
  return {
    page_url: location.href,
    captured_at: new Date().toISOString(),
    selector,
    screenshot_meta: {
      page_url: location.href,
      captured_at: new Date().toISOString(),
      selector,
      image_width: Number(canvas.width || 0),
      image_height: Number(canvas.height || 0),
      capture_scale:
        Number(selector_rect_css.width) > 0
          ? Number(canvas.width || 0) / Number(selector_rect_css.width)
          : undefined,
      device_pixel_ratio: Number(window.devicePixelRatio || 1),
      scroll_x: Number(window.scrollX || window.pageXOffset || 0),
      scroll_y: Number(window.scrollY || window.pageYOffset || 0),
      selector_rect_css,
      viewport_css,
    },
    wait_for_idle_ms: waitForIdleMs,
    wait_for_idle_timed_out,
    png_data_url,
  };
} finally {
  try {
    if (stream) {
      for (const track of stream.getTracks?.() ?? []) {
        try {
          track.stop();
        } catch {}
      }
    }
  } catch {}
}
`.trim();
}

export async function captureScreenshotViaSpawnedDaemon({
  browser_id,
  selector,
  waitForIdleMs,
  timeoutMs,
  fullPage,
  viewportWidth,
  viewportHeight,
}: {
  browser_id: string;
  selector: string;
  waitForIdleMs: number;
  timeoutMs: number;
  fullPage: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
}): Promise<{
  result: Record<string, unknown>;
  spawned: { file: string; state: SpawnStateRecord };
}> {
  const spawned = resolveSpawnStateByBrowserId(browser_id);
  if (!spawned) {
    throw new Error(`no local spawned browser daemon found for browser '${browser_id}'`);
  }
  const ipcDir = resolveSpawnIpcDir(spawned);
  mkdirSync(ipcDir, { recursive: true });
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const requestPath = join(ipcDir, `${requestId}.request.json`);
  const responsePath = join(ipcDir, `${requestId}.response.json`);
  const payload: SpawnedScreenshotRequest = {
    request_id: requestId,
    action: "screenshot",
    selector,
    wait_for_idle_ms: waitForIdleMs,
    timeout_ms: timeoutMs,
    ...(fullPage ? { full_page: true } : {}),
    ...(viewportWidth != null ? { viewport_width: viewportWidth } : {}),
    ...(viewportHeight != null ? { viewport_height: viewportHeight } : {}),
  };
  await writeFile(requestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const started = Date.now();
  for (;;) {
    if (existsSync(responsePath)) {
      const raw = await readFile(responsePath, "utf8");
      try {
        unlinkSync(responsePath);
      } catch {
        // best-effort cleanup
      }
      let parsed: SpawnedScreenshotResponse;
      try {
        parsed = JSON.parse(raw) as SpawnedScreenshotResponse;
      } catch (err) {
        throw new Error(`invalid spawned screenshot response: ${err}`);
      }
      if (!parsed || typeof parsed !== "object") {
        throw new Error("invalid spawned screenshot response payload");
      }
      if (!parsed.ok) {
        throw new Error(`${parsed.error || "spawned screenshot request failed"}`);
      }
      return { result: parsed.result ?? {}, spawned };
    }
    if (Date.now() - started > timeoutMs) {
      try {
        unlinkSync(requestPath);
      } catch {
        // ignore cleanup races
      }
      throw new Error("timed out waiting for spawned screenshot response");
    }
    await sleep(100);
  }
}
