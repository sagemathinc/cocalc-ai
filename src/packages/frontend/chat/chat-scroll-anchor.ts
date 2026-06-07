/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface ChatViewportAnchor {
  atBottom: boolean;
  date?: string;
  offsetPx: number;
  savedAt: number;
}

export interface CaptureChatViewportAnchorOptions {
  forceAtBottom?: boolean;
  now?: number;
  scroller: HTMLElement | null | undefined;
  sortedDates: string[];
}

export interface RestoreChatViewportAnchorOptions {
  anchor: ChatViewportAnchor;
  scroller: HTMLElement | null | undefined;
  sortedDates: string[];
}

const STORAGE_KEY = "cocalc-chat-scroll-anchor-cache";
const MAX_CACHE_ENTRIES = 250;
const BOTTOM_EPSILON_PX = 32;
const RESTORE_TOLERANCE_PX = 3;
const MIN_USABLE_VIEWPORT_PX = 80;
const MIN_USABLE_SCROLL_HEIGHT_PX = 120;

const anchorCache = new Map<string, ChatViewportAnchor>();
let loadedFromStorage = false;

function hasStorage(): boolean {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  );
}

function loadFromStorage(): void {
  if (loadedFromStorage) return;
  loadedFromStorage = true;
  if (!hasStorage()) return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, anchor] = entry;
      if (typeof key !== "string" || !isViableAnchor(anchor)) continue;
      anchorCache.set(key, anchor);
    }
  } catch {
    // Best-effort cache only.
  }
}

function persistToStorage(): void {
  if (!hasStorage()) return;
  try {
    const entries = Array.from(anchorCache.entries())
      .sort((a, b) => (b[1].savedAt ?? 0) - (a[1].savedAt ?? 0))
      .slice(0, MAX_CACHE_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Best-effort cache only.
  }
}

function isViableAnchor(value: unknown): value is ChatViewportAnchor {
  const anchor = value as ChatViewportAnchor;
  if (anchor == null || typeof anchor !== "object") return false;
  if (typeof anchor.atBottom !== "boolean") return false;
  if (
    typeof anchor.offsetPx !== "number" ||
    !Number.isFinite(anchor.offsetPx)
  ) {
    return false;
  }
  if (typeof anchor.savedAt !== "number" || !Number.isFinite(anchor.savedAt)) {
    return false;
  }
  if (anchor.date != null && typeof anchor.date !== "string") return false;
  return true;
}

export function loadChatViewportAnchor(
  cacheId: string | undefined,
): ChatViewportAnchor | undefined {
  if (!cacheId) return undefined;
  loadFromStorage();
  return anchorCache.get(cacheId);
}

export function saveChatViewportAnchor(
  cacheId: string | undefined,
  anchor: ChatViewportAnchor | undefined,
): void {
  if (!cacheId || !anchor) return;
  loadFromStorage();
  anchorCache.set(cacheId, anchor);
  if (anchorCache.size > MAX_CACHE_ENTRIES) {
    const oldest = Array.from(anchorCache.entries()).sort(
      (a, b) => (a[1].savedAt ?? 0) - (b[1].savedAt ?? 0),
    )[0]?.[0];
    if (oldest) anchorCache.delete(oldest);
  }
  persistToStorage();
}

export function clearChatViewportAnchorCacheForTests(): void {
  anchorCache.clear();
  loadedFromStorage = true;
  if (hasStorage()) {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

export function isChatScrollerAtBottom(
  scroller: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
): boolean {
  if (!isUsableChatScroller(scroller)) return false;
  return (
    scroller.scrollTop + scroller.clientHeight >=
    scroller.scrollHeight - BOTTOM_EPSILON_PX
  );
}

export function isUsableChatScroller(
  scroller:
    | Pick<HTMLElement, "clientHeight" | "scrollHeight">
    | null
    | undefined,
): boolean {
  if (!scroller) return false;
  const height = scroller.clientHeight ?? 0;
  const scrollHeight = scroller.scrollHeight ?? 0;
  if (height < MIN_USABLE_VIEWPORT_PX) return false;
  if (scrollHeight < MIN_USABLE_SCROLL_HEIGHT_PX) return false;
  return true;
}

export function resolveChatViewportAnchorIndex(
  anchor: ChatViewportAnchor | undefined,
  sortedDates: string[],
): number | undefined {
  if (!anchor || sortedDates.length === 0) return undefined;
  if (anchor.atBottom || anchor.date == null) {
    return sortedDates.length - 1;
  }
  const exact = sortedDates.indexOf(anchor.date);
  if (exact >= 0) return exact;
  const target = Number(anchor.date);
  if (!Number.isFinite(target)) return undefined;
  for (let i = 0; i < sortedDates.length; i += 1) {
    const value = Number(sortedDates[i]);
    if (Number.isFinite(value) && value >= target) {
      return i;
    }
  }
  return sortedDates.length - 1;
}

export function captureChatViewportAnchor({
  forceAtBottom,
  now = Date.now(),
  scroller,
  sortedDates,
}: CaptureChatViewportAnchorOptions): ChatViewportAnchor | undefined {
  if (!scroller || sortedDates.length === 0) return undefined;
  if (!isUsableChatScroller(scroller)) return undefined;
  const atBottom = forceAtBottom === true || isChatScrollerAtBottom(scroller);
  if (atBottom) {
    return {
      atBottom: true,
      date: sortedDates[sortedDates.length - 1],
      offsetPx: 0,
      savedAt: now,
    };
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const items = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-item-index]"),
  );
  for (const item of items) {
    const index = getItemIndex(item);
    if (index == null || index < 0 || index >= sortedDates.length) continue;
    const rect = item.getBoundingClientRect();
    if (rect.bottom <= scrollerRect.top + 1) continue;
    if (rect.top >= scrollerRect.bottom - 1) continue;
    return {
      atBottom: false,
      date: sortedDates[index],
      offsetPx: rect.top - scrollerRect.top,
      savedAt: now,
    };
  }
  return undefined;
}

export function restoreChatViewportAnchorOffset({
  anchor,
  scroller,
  sortedDates,
}: RestoreChatViewportAnchorOptions): boolean {
  if (!scroller || anchor.atBottom) return true;
  const index = resolveChatViewportAnchorIndex(anchor, sortedDates);
  if (index == null) return false;
  const item = scroller.querySelector<HTMLElement>(
    `[data-item-index="${index}"]`,
  );
  if (!item) return false;
  const scrollerRect = scroller.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const delta = itemRect.top - scrollerRect.top - anchor.offsetPx;
  if (Math.abs(delta) <= RESTORE_TOLERANCE_PX) return true;
  scroller.scrollTop += delta;
  return Math.abs(delta) <= RESTORE_TOLERANCE_PX;
}

function getItemIndex(item: HTMLElement): number | undefined {
  const raw = item.getAttribute("data-item-index");
  if (raw == null) return undefined;
  const index = Number(raw);
  return Number.isInteger(index) ? index : undefined;
}
