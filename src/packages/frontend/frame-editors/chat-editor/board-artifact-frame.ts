/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Which file artifacts are Sagebrush boards, and where they run. Kept apart
// from board-artifact.tsx, which is loaded only when a board is shown.

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { is_https_or_loopback_url } from "@cocalc/util/db-schema/site-defaults";

// Boards embed their pictures, so they are larger than other text previews.
export const BOARD_PREVIEW_LIMIT = 16 * 1024 * 1024;

export const BOARD_FRAME_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads";

export function isBoardPath(path: string): boolean {
  return path.toLowerCase().endsWith(".board.json");
}

/** The frame page on the configured Sagebrush origin, or undefined if the
 * setting is blank or not https (http only for localhost). */
export function boardFrameUrl(origin: unknown): string | undefined {
  const value = `${origin ?? ""}`.trim();
  if (!value || !is_https_or_loopback_url(value)) return;
  return `${new URL(value).origin}/frame/board/`;
}

/** The configured frame page; null when live boards are off; undefined until
 * the site's settings have arrived. Before then the customize store holds
 * only the public defaults, which may not be this site's choice, and a board
 * must not be sent anywhere on their say-so. */
export function useBoardFrameUrl(): string | null | undefined {
  const configured = useTypedRedux("customize", "_is_configured");
  const origin = useTypedRedux("customize", "sagebrush_origin");
  if (!configured) return undefined;
  return boardFrameUrl(origin) ?? null;
}
