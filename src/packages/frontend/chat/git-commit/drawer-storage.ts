/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: persistent drawer size and scroll-position storage for the git commit review drawer.

import type { DrawerScrollState } from "./types";

const DRAWER_SIZE_STORAGE_KEY = "cocalc:chat:gitCommitDrawerSize";
const DRAWER_SCROLL_STORAGE_KEY = "cocalc:chat:gitCommitDrawerScroll:v1";
const MAX_DRAWER_SCROLL_ENTRIES = 50;
const DEFAULT_DRAWER_SIZE = 920;
const MIN_DRAWER_SIZE = 520;
const MAX_DRAWER_SIZE = 1800;

export function clampDrawerSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_DRAWER_SIZE;
  return Math.max(MIN_DRAWER_SIZE, Math.min(MAX_DRAWER_SIZE, Math.round(size)));
}

export function readDrawerSize(): number {
  try {
    const raw = localStorage.getItem(DRAWER_SIZE_STORAGE_KEY);
    if (!raw) return DEFAULT_DRAWER_SIZE;
    const parsed = Number(raw);
    return clampDrawerSize(parsed);
  } catch {
    return DEFAULT_DRAWER_SIZE;
  }
}

export function persistDrawerSize(size: number): void {
  try {
    localStorage.setItem(
      DRAWER_SIZE_STORAGE_KEY,
      String(clampDrawerSize(size)),
    );
  } catch {
    // ignore
  }
}

function normalizeDrawerScrollState(raw: unknown): DrawerScrollState {
  const fallback: DrawerScrollState = { entries: {}, order: [] };
  if (!raw || typeof raw !== "object") return fallback;
  const record = raw as Record<string, unknown>;
  const entriesRaw = record.entries;
  const orderRaw = record.order;
  const entries: DrawerScrollState["entries"] = {};
  if (entriesRaw && typeof entriesRaw === "object") {
    for (const [key, value] of Object.entries(
      entriesRaw as Record<string, unknown>,
    )) {
      if (!key || !value || typeof value !== "object") continue;
      const top = Number((value as Record<string, unknown>).top);
      const updated = Number((value as Record<string, unknown>).updated_at);
      if (!Number.isFinite(top) || top < 0) continue;
      entries[key] = {
        top: Math.round(top),
        updated_at:
          Number.isFinite(updated) && updated > 0
            ? Math.round(updated)
            : Date.now(),
      };
    }
  }
  const order = Array.isArray(orderRaw)
    ? orderRaw
        .map((x) => `${x ?? ""}`.trim())
        .filter(
          (x, i, arr) => !!x && arr.indexOf(x) === i && entries[x] != null,
        )
    : [];
  for (const key of Object.keys(entries)) {
    if (!order.includes(key)) order.push(key);
  }
  return { entries, order };
}

function readDrawerScrollState(): DrawerScrollState {
  try {
    const raw = localStorage.getItem(DRAWER_SCROLL_STORAGE_KEY);
    if (!raw) return { entries: {}, order: [] };
    return normalizeDrawerScrollState(JSON.parse(raw));
  } catch {
    return { entries: {}, order: [] };
  }
}

function persistDrawerScrollState(state: DrawerScrollState): void {
  try {
    localStorage.setItem(DRAWER_SCROLL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function readDrawerScrollPosition(
  storageId: string,
): number | undefined {
  if (!storageId) return undefined;
  const entry = readDrawerScrollState().entries[storageId];
  if (!entry) return undefined;
  if (!Number.isFinite(entry.top) || entry.top < 0) return undefined;
  return entry.top;
}

export function persistDrawerScrollPosition(
  storageId: string,
  top: number,
): void {
  if (!storageId) return;
  if (!Number.isFinite(top) || top < 0) return;
  const state = readDrawerScrollState();
  const id = `${storageId}`.trim();
  if (!id) return;
  const now = Date.now();
  state.entries[id] = { top: Math.round(top), updated_at: now };
  const order = state.order.filter((x) => x !== id);
  order.push(id);
  while (order.length > MAX_DRAWER_SCROLL_ENTRIES) {
    const drop = order.shift();
    if (!drop) continue;
    delete state.entries[drop];
  }
  state.order = order;
  persistDrawerScrollState(state);
}
