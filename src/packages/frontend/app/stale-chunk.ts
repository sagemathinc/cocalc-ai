/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Stale frontend chunks: a lazy chunk this tab's build needs that the server
// no longer has, because the frontend was updated. Kept free of the webapp
// client so that error boundaries on public pages can use it; the signed-in
// build monitor (frontend-build-monitor.ts) listens here.

export const REFRESH_QUERY_PARAM = "_cocalc_refresh";

export function isLikelyStaleChunkError(value: unknown): boolean {
  const message = `${
    (value as any)?.reason?.message ??
    (value as any)?.error?.message ??
    (value as any)?.message ??
    value ??
    ""
  }`;
  return /ChunkLoadError|Loading (?:CSS )?chunk|__webpack_require__|__webpack_modules__/i.test(
    message,
  );
}

export function reloadForFrontendBuild(manifest?: {
  build_timestamp?: number;
}): void {
  const url = new URL(window.location.href);
  url.searchParams.set(
    REFRESH_QUERY_PARAM,
    `${manifest?.build_timestamp ?? Date.now()}`,
  );
  window.location.replace(url.toString());
}

let staleChunkSeen = false;
const listeners = new Set<() => void>();

// Records a stale chunk, so every reload indicator can recommend a reload.
// Error boundaries call this: they catch the error before window handlers
// see it. Returns whether the error was a stale chunk.
export function reportStaleChunkError(error: unknown): boolean {
  if (!isLikelyStaleChunkError(error)) return false;
  staleChunkSeen = true;
  for (const listener of listeners) listener();
  return true;
}

export function staleChunkErrorSeen(): boolean {
  return staleChunkSeen;
}

export function onStaleChunkError(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
