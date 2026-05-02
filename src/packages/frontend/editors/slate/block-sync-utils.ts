// Shared utilities for block sync settings and debug logging.
// These helpers centralize configurable thresholds so block sync behavior stays
// consistent across hooks and editor components.

import { ensureSlateDebug, logSlateDebug } from "./slate-utils/slate-debug";

const BLOCK_DEFER_CHARS = 200_000;
const BLOCK_DEFER_MS = 300;

export function getBlockDeferChars(): number {
  if (typeof globalThis === "undefined") return BLOCK_DEFER_CHARS;
  const value = (globalThis as any).COCALC_SLATE_BLOCK_DEFER_CHARS;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return BLOCK_DEFER_CHARS;
}

export function getBlockDeferMs(): number {
  if (typeof globalThis === "undefined") return BLOCK_DEFER_MS;
  const value = (globalThis as any).COCALC_SLATE_BLOCK_DEFER_MS;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return BLOCK_DEFER_MS;
}

export function debugSyncLog(
  type: string,
  data?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  if (!(window as any).__slateDebugLog) return;
  ensureSlateDebug();
  logSlateDebug(`block-sync:${type}`, data);
  // eslint-disable-next-line no-console
  console.log(`[slate-sync:block] ${type}`, data ?? {});
}

function checksum(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function previewStart(text: string, size = 80): string {
  return text.slice(0, size).replace(/\n/g, "\\n");
}

function previewEnd(text: string, size = 80): string {
  return text.slice(-size).replace(/\n/g, "\\n");
}

export function summarizeMarkdown(text: string): Record<string, unknown> {
  return {
    length: text.length,
    lines: text === "" ? 0 : text.split("\n").length,
    checksum: checksum(text),
    start: previewStart(text),
    end: previewEnd(text),
  };
}
