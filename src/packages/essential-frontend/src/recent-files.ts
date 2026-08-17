/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

const MAX_RECENT_FILES = 60;
const MAX_PATH_LENGTH = 4_096;

export interface RecentFile {
  openedAt: number;
  path: string;
  projectId: string;
  projectTitle: string;
}

function recentKey(accountId: string): string {
  return `cocalc-essential-recent:${accountId}`;
}

function hiddenKey(accountId: string): string {
  return `cocalc-essential-show-hidden:${accountId}`;
}

function validRecentFile(value: unknown): value is RecentFile {
  if (value == null || typeof value !== "object") return false;
  const item = value as Partial<RecentFile>;
  return (
    typeof item.openedAt === "number" &&
    Number.isFinite(item.openedAt) &&
    typeof item.path === "string" &&
    item.path.startsWith("/home/user") &&
    item.path.length <= MAX_PATH_LENGTH &&
    typeof item.projectId === "string" &&
    typeof item.projectTitle === "string"
  );
}

export function readRecentFiles(accountId: string): RecentFile[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(recentKey(accountId)) || "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter(validRecentFile).slice(0, MAX_RECENT_FILES)
      : [];
  } catch {
    return [];
  }
}

export function recordRecentFile(
  accountId: string,
  item: Omit<RecentFile, "openedAt">,
): void {
  try {
    const next = [
      { ...item, openedAt: Date.now() },
      ...readRecentFiles(accountId).filter(
        ({ path, projectId }) =>
          path !== item.path || projectId !== item.projectId,
      ),
    ].slice(0, MAX_RECENT_FILES);
    localStorage.setItem(recentKey(accountId), JSON.stringify(next));
  } catch {
    // Private browsing and quota limits must not block file access.
  }
}

export function clearRecentFiles(accountId: string, projectId?: string): void {
  try {
    if (!projectId) {
      localStorage.removeItem(recentKey(accountId));
      return;
    }
    localStorage.setItem(
      recentKey(accountId),
      JSON.stringify(
        readRecentFiles(accountId).filter(
          (item) => item.projectId !== projectId,
        ),
      ),
    );
  } catch {
    // Treat unavailable storage as an already-empty recent list.
  }
}

export function readShowHidden(accountId: string): boolean {
  try {
    return localStorage.getItem(hiddenKey(accountId)) === "true";
  } catch {
    return false;
  }
}

export function writeShowHidden(accountId: string, value: boolean): void {
  try {
    localStorage.setItem(hiddenKey(accountId), `${value}`);
  } catch {
    // This preference is intentionally best effort.
  }
}
