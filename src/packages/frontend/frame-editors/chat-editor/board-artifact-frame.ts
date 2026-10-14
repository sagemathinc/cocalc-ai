/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Which file artifacts are Sagebrush boards, and where they run. Kept apart
// from board-artifact.tsx, which is loaded only when a board is shown.

import { useTypedRedux } from "@cocalc/frontend/app-framework";

// Boards embed their pictures, so they are larger than other text previews.
export const BOARD_PREVIEW_LIMIT = 16 * 1024 * 1024;

export const BOARD_FRAME_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads";

export function isBoardPath(path: string): boolean {
  return path.toLowerCase().endsWith(".board.json");
}

/** The frame page on the configured Sagebrush origin, or undefined if the
 * setting is blank or not an http(s) URL. */
export function boardFrameUrl(origin: unknown): string | undefined {
  const value = `${origin ?? ""}`.trim();
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    return `${url.origin}/frame/board/`;
  } catch {
    return;
  }
}

/** The configured frame page, if live board previews are on. */
export function useBoardFrameUrl(): string | undefined {
  const origin = useTypedRedux("customize", "sagebrush_origin");
  return boardFrameUrl(origin ?? "https://sagebrush.space");
}
