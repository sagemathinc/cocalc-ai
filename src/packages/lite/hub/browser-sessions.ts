/*
In-memory browser session registry for lite hub system RPC endpoints.
*/

import type {
  BrowserOpenProjectState,
  BrowserSessionInfo,
} from "@cocalc/conat/hub/api/system";

const DEFAULT_MAX_AGE_MS = 2 * 60_000;
const MAX_ALLOWED_AGE_MS = 24 * 60 * 60_000;
const MAX_SESSION_RETENTION_MS = 24 * 60 * 60_000;
const MAX_OPEN_PROJECTS = 64;
const MAX_OPEN_FILES_PER_PROJECT = 256;

type BrowserSessionRecord = {
  account_id: string;
  browser_id: string;
  session_name?: string;
  url?: string;
  active_project_id?: string;
  open_projects: BrowserOpenProjectState[];
  created_at_ms: number;
  updated_at_ms: number;
};

const registry = new Map<string, BrowserSessionRecord>();

function key(account_id: string, browser_id: string): string {
  return `${account_id}:${browser_id}`;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function cleanOpenProjects(value: unknown): BrowserOpenProjectState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: BrowserOpenProjectState[] = [];
  for (const row of value.slice(0, MAX_OPEN_PROJECTS)) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const project_id = cleanText((row as any).project_id);
    if (!project_id) {
      continue;
    }
    const title = cleanText((row as any).title);
    const filesRaw = Array.isArray((row as any).open_files)
      ? (row as any).open_files
      : [];
    const open_files = filesRaw
      .map(cleanText)
      .filter((entry): entry is string => !!entry)
      .slice(0, MAX_OPEN_FILES_PER_PROJECT);
    out.push({
      project_id,
      ...(title ? { title } : {}),
      open_files,
    });
  }
  return out;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function normalizeMaxAgeMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_AGE_MS;
  }
  return Math.min(MAX_ALLOWED_AGE_MS, Math.floor(parsed));
}

function pruneStaleRecords(now = Date.now()): void {
  for (const [k, record] of registry) {
    if (now - record.updated_at_ms > MAX_SESSION_RETENTION_MS) {
      registry.delete(k);
    }
  }
}

export function upsertBrowserSessionRecord({
  account_id,
  browser_id,
  session_name,
  url,
  active_project_id,
  open_projects,
}: {
  account_id: string;
  browser_id: string;
  session_name?: unknown;
  url?: unknown;
  active_project_id?: unknown;
  open_projects?: unknown;
}): { browser_id: string; created_at: string; updated_at: string } {
  const now = Date.now();
  pruneStaleRecords(now);
  const cleanedBrowserId = cleanText(browser_id);
  if (!cleanedBrowserId) {
    throw Error("browser_id must be specified");
  }
  const current = registry.get(key(account_id, cleanedBrowserId));
  const next: BrowserSessionRecord = {
    account_id,
    browser_id: cleanedBrowserId,
    session_name: cleanText(session_name),
    url: cleanText(url),
    active_project_id: cleanText(active_project_id),
    open_projects: cleanOpenProjects(open_projects),
    created_at_ms: current?.created_at_ms ?? now,
    updated_at_ms: now,
  };
  registry.set(key(account_id, cleanedBrowserId), next);
  return {
    browser_id: cleanedBrowserId,
    created_at: toIso(next.created_at_ms),
    updated_at: toIso(next.updated_at_ms),
  };
}

export function listBrowserSessionsForAccount({
  account_id,
  max_age_ms,
  include_stale,
}: {
  account_id: string;
  max_age_ms?: unknown;
  include_stale?: unknown;
}): BrowserSessionInfo[] {
  const now = Date.now();
  pruneStaleRecords(now);
  const maxAgeMs = normalizeMaxAgeMs(max_age_ms);
  const includeStale = include_stale === true;
  const out: BrowserSessionInfo[] = [];
  for (const record of registry.values()) {
    if (record.account_id !== account_id) {
      continue;
    }
    const age = now - record.updated_at_ms;
    const stale = age > maxAgeMs;
    if (!includeStale && stale) {
      continue;
    }
    out.push({
      browser_id: record.browser_id,
      ...(record.session_name ? { session_name: record.session_name } : {}),
      ...(record.url ? { url: record.url } : {}),
      ...(record.active_project_id
        ? { active_project_id: record.active_project_id }
        : {}),
      open_projects: record.open_projects,
      created_at: toIso(record.created_at_ms),
      updated_at: toIso(record.updated_at_ms),
      stale,
    });
  }
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

export function removeBrowserSessionRecord({
  account_id,
  browser_id,
}: {
  account_id: string;
  browser_id: string;
}): boolean {
  const cleanedBrowserId = cleanText(browser_id);
  if (!cleanedBrowserId) {
    throw Error("browser_id must be specified");
  }
  return registry.delete(key(account_id, cleanedBrowserId));
}
