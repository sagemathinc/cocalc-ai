/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const STORAGE_KEY = "cocalc:recently-created-projects:v1";
export const RECENT_PROJECT_WINDOW_MS = 10 * 60 * 1000;

function createdMs(value: unknown): number | undefined {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : new Date(`${value ?? ""}`).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function readRecentProjects(): Record<string, number> {
  if (typeof sessionStorage === "undefined") {
    return {};
  }
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed != null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRecentProjects(value: Record<string, number>): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Best-effort UX hint; do not fail project creation if storage is blocked.
  }
}

export function markProjectRecentlyCreated(project_id: string): void {
  if (!project_id) return;
  const now = Date.now();
  const recent = readRecentProjects();
  for (const [id, at] of Object.entries(recent)) {
    if (now - at > RECENT_PROJECT_WINDOW_MS) {
      delete recent[id];
    }
  }
  recent[project_id] = now;
  writeRecentProjects(recent);
}

export function isProjectRecentlyCreated({
  project_id,
  created,
  nowMs = Date.now(),
  windowMs = RECENT_PROJECT_WINDOW_MS,
}: {
  project_id: string;
  created?: unknown;
  nowMs?: number;
  windowMs?: number;
}): boolean {
  const createdAt = createdMs(created);
  if (createdAt != null && nowMs - createdAt <= windowMs) {
    return true;
  }
  const markedAt = readRecentProjects()[project_id];
  return markedAt != null && nowMs - markedAt <= windowMs;
}
