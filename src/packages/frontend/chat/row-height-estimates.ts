/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Heights for chat log rows the list has not drawn yet. The virtualized list
// draws only rows near the screen and must guess the rest; when a guess is
// wrong, it moves the scroll position as the row is drawn, which is the jump
// a reader sees. Rows already measured once (in this browser tab) use their
// measured height; others get an estimate from their text and images.

/** Images without a size of their own get a box of this height in the log,
 * so a row does not grow when its image loads. */
export const CHAT_IMAGE_BOX_HEIGHT = 320;

const MAX_CHATS = 50;
type Measured = {
  height: number;
  /** What it was measured with: its content and the log's layout. */
  content: string;
  layout: string;
};
// cacheId (a chat) -> row key -> measurement, most recent chat last.
const measured = new Map<string, Map<string, Measured>>();

/**
 * content: identifies the row's content (e.g., its text's length), so an
 * edited row is not given its old height; layout: the log's width and font
 * size when measured.
 */
export function rememberRowHeight(
  cacheId: string,
  key: string,
  height: number,
  { content = "", layout = "" }: { content?: string; layout?: string } = {},
): void {
  if (!(height > 0)) return;
  let rows = measured.get(cacheId);
  if (rows == null) {
    rows = new Map();
    if (measured.size >= MAX_CHATS) {
      const oldest = measured.keys().next().value;
      if (oldest != null) measured.delete(oldest);
    }
  } else {
    measured.delete(cacheId);
  }
  measured.set(cacheId, rows);
  rows.set(key, { height, content, layout });
}

/** Only while the row's content, and the layout if known, are the same. */
export function rememberedRowHeight(
  cacheId: string,
  key: string,
  { content = "", layout }: { content?: string; layout?: string } = {},
): number | undefined {
  const row = measured.get(cacheId)?.get(key);
  if (row == null || row.content !== content) return undefined;
  if (layout != null && row.layout !== layout) return undefined;
  return row.height;
}

const IMAGE = /!\[[^\]]*\]\(|<img\b/gi;

/** A rough height for a message row from its Markdown. */
export function estimateMessageRowHeight(text: string | undefined): number {
  const value = text ?? "";
  const images = value.match(IMAGE)?.length ?? 0;
  let lines = 0;
  for (const line of value.split("\n")) {
    lines += Math.max(1, Math.ceil(line.length / 90));
  }
  // Header and padding, lines of text, and a box per image.
  return Math.min(
    64 + lines * 22 + images * (CHAT_IMAGE_BOX_HEIGHT + 16),
    20_000,
  );
}

/** Forget everything (tests). */
export function clearRowHeights(): void {
  measured.clear();
}
