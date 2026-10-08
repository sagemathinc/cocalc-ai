/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import TTL from "@isaacs/ttlcache";
import { posix } from "node:path";
import getLogger from "@cocalc/backend/logger";
import type { Client } from "@cocalc/conat/core/client";
import {
  type DocumentActivityAction,
  type FileUseTimesResponse,
  type RecentProjectDocumentActivityEntry,
} from "@cocalc/conat/project/document-activity";
import { dkv, type DKV } from "@cocalc/conat/sync/dkv";
import { dstream, type DStream } from "@cocalc/conat/sync/dstream";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import { isValidUUID } from "@cocalc/util/misc";
import { syncdbPath } from "@cocalc/util/jupyter/names";
import {
  DEFAULT_PROJECT_RUNTIME_HOME,
  PROJECT_RUNTIME_HOME_ALIASES,
} from "@cocalc/util/project-runtime";

const logger = getLogger("project-host:document-activity");

export const PROJECT_DOCUMENT_ACTIVITY_SUBJECT =
  "services.*.*.*.*.document-activity";
export const PROJECT_DOCUMENT_ACTIVITY_RECENT_NAME =
  "project-document-activity-recent";
export const PROJECT_DOCUMENT_ACTIVITY_EVENTS_NAME =
  "project-document-activity-events";

const MAX_RECENT_ACCOUNTS = 5;
const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 500;
const DEFAULT_MAX_AGE_S = 90 * 24 * 60 * 60;
const DOCUMENT_ACTIVITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const FILE_ACCESS_THROTTLE_MS = 60_000;

interface ActivitySubject {
  account_id: string;
  project_id: string;
}

interface RecentDocumentActivityRow {
  path: string;
  last_accessed: string;
  recent_accounts?: Record<string, string>;
}

interface FileAccessEvent {
  time: string;
  account_id: string;
  path: string;
  action: DocumentActivityAction;
}

const recentStores = new TTL<string, DKV<RecentDocumentActivityRow>>({
  ttl: 30 * 60_000,
  dispose: (store) => {
    try {
      store.close();
    } catch {
      // ignore close errors
    }
  },
});

const recentStoreInflight = new Map<
  string,
  Promise<DKV<RecentDocumentActivityRow>>
>();

const accessStreams = new TTL<string, DStream<FileAccessEvent>>({
  ttl: 30 * 60_000,
  dispose: (stream) => {
    try {
      stream.close();
    } catch {
      // ignore close errors
    }
  },
});

const accessStreamInflight = new Map<
  string,
  Promise<DStream<FileAccessEvent>>
>();

const accessThrottle = new TTL<string, true>({ ttl: FILE_ACCESS_THROTTLE_MS });

function parseActivitySubject(subject?: string): ActivitySubject {
  const parts = `${subject ?? ""}`.split(".");
  if (
    parts.length !== 6 ||
    parts[0] !== "services" ||
    parts[5] !== "document-activity"
  ) {
    throw new Error(
      `invalid project document activity subject '${subject ?? ""}'`,
    );
  }
  const account_id = `${parts[1] ?? ""}`.startsWith("account-")
    ? parts[1].slice("account-".length)
    : "";
  const project_id = `${parts[3] ?? ""}`.trim();
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) {
    throw new Error(
      `invalid project document activity subject '${subject ?? ""}'`,
    );
  }
  return { account_id, project_id };
}

function assertCollaborator({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): void {
  const row = getRow("projects", JSON.stringify({ project_id }));
  const userEntry = row?.users?.[account_id];
  const group = typeof userEntry === "string" ? userEntry : userEntry?.group;
  if (!isProjectCollaboratorGroup(group)) {
    throw new Error(
      `account '${account_id}' is not a collaborator on project '${project_id}'`,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileSearchPattern(search?: string): RegExp | undefined {
  const pattern = `${search ?? ""}`.trim();
  if (!pattern) {
    return;
  }
  const wildcard = `%${pattern}%`;
  let regex = "^";
  let escaped = false;
  for (const ch of wildcard) {
    if (!escaped && ch === "\\") {
      escaped = true;
      continue;
    }
    if (!escaped && ch === "%") {
      regex += ".*";
    } else if (!escaped && ch === "_") {
      regex += ".";
    } else {
      regex += escapeRegExp(ch);
    }
    escaped = false;
  }
  if (escaped) {
    regex += escapeRegExp("\\");
  }
  regex += "$";
  return new RegExp(regex, "i");
}

function normalizeLimit(limit?: number): number {
  const n = Math.floor(Number(limit ?? DEFAULT_RECENT_LIMIT));
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_RECENT_LIMIT;
  }
  return Math.min(MAX_RECENT_LIMIT, n);
}

function normalizeMaxAgeSeconds(max_age_s?: number): number {
  const n = Math.floor(Number(max_age_s ?? DEFAULT_MAX_AGE_S));
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_MAX_AGE_S;
  }
  return Math.min(DEFAULT_MAX_AGE_S, n);
}

function sortRecentAccounts(
  recent_accounts?: Record<string, string>,
): string[] {
  return Object.entries(recent_accounts ?? {})
    .sort((left, right) => {
      const a = Date.parse(left[1]);
      const b = Date.parse(right[1]);
      if (Number.isFinite(a) && Number.isFinite(b) && b !== a) {
        return b - a;
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, MAX_RECENT_ACCOUNTS)
    .map(([account_id]) => account_id);
}

function pruneRecentAccounts({
  recent_accounts,
  nowMs,
}: {
  recent_accounts?: Record<string, string>;
  nowMs: number;
}): Record<string, string> {
  const filtered = Object.entries(recent_accounts ?? {}).filter(([, value]) => {
    const t = Date.parse(value);
    return Number.isFinite(t) && nowMs - t <= DOCUMENT_ACTIVITY_TTL_MS;
  });
  filtered.sort((left, right) => {
    const a = Date.parse(left[1]);
    const b = Date.parse(right[1]);
    if (b !== a) {
      return b - a;
    }
    return left[0].localeCompare(right[0]);
  });
  return Object.fromEntries(filtered.slice(0, MAX_RECENT_ACCOUNTS));
}

async function getRecentStore({
  client,
  project_id,
}: {
  client: Client;
  project_id: string;
}): Promise<DKV<RecentDocumentActivityRow>> {
  const cached = recentStores.get(project_id);
  if (cached && !cached.isClosed()) {
    return cached;
  }
  const inflight = recentStoreInflight.get(project_id);
  if (inflight) {
    return await inflight;
  }
  const promise = dkv<RecentDocumentActivityRow>({
    project_id,
    name: PROJECT_DOCUMENT_ACTIVITY_RECENT_NAME,
    client,
  })
    .then((store) => {
      recentStores.set(project_id, store);
      return store;
    })
    .finally(() => recentStoreInflight.delete(project_id));
  recentStoreInflight.set(project_id, promise);
  return await promise;
}

async function getAccessStream({
  client,
  project_id,
}: {
  client: Client;
  project_id: string;
}): Promise<DStream<FileAccessEvent>> {
  const cached = accessStreams.get(project_id);
  if (cached && !cached.isClosed()) {
    return cached;
  }
  const inflight = accessStreamInflight.get(project_id);
  if (inflight) {
    return await inflight;
  }
  const promise = dstream<FileAccessEvent>({
    project_id,
    name: PROJECT_DOCUMENT_ACTIVITY_EVENTS_NAME,
    client,
  })
    .then(async (stream) => {
      try {
        await stream.config({ allow_msg_ttl: true });
      } catch (err) {
        stream.close();
        throw err;
      }
      accessStreams.set(project_id, stream);
      return stream;
    })
    .finally(() => accessStreamInflight.delete(project_id));
  accessStreamInflight.set(project_id, promise);
  return await promise;
}

export async function handleMarkFileRequest(
  this: { subject?: string },
  opts: { path: string; action: DocumentActivityAction } | undefined,
  client: Client,
): Promise<null> {
  const { account_id, project_id } = parseActivitySubject(this?.subject);
  assertCollaborator({ account_id, project_id });
  const path = `${opts?.path ?? ""}`.trim();
  const action = opts?.action;
  if (!path) {
    throw new Error("path must be specified");
  }
  if (action !== "open" && action !== "edit" && action !== "chat") {
    throw new Error(`invalid document activity action '${action ?? ""}'`);
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.valueOf();
  const store = await getRecentStore({ client, project_id });
  const current = store.get(path);
  const recent_accounts = pruneRecentAccounts({
    recent_accounts: current?.recent_accounts,
    nowMs,
  });
  recent_accounts[account_id] = nowIso;
  store.set(path, {
    path,
    last_accessed: nowIso,
    recent_accounts: pruneRecentAccounts({ recent_accounts, nowMs }),
  });

  const throttleKey = `${project_id}:${account_id}:${path}:${action}`;
  if (!accessThrottle.has(throttleKey)) {
    const stream = await getAccessStream({ client, project_id });
    // Concurrent callers may have published while this one awaited the stream.
    // A failed open/publish must not suppress the next recording attempt.
    if (!accessThrottle.has(throttleKey)) {
      stream.publish(
        {
          time: nowIso,
          account_id,
          path,
          action,
        },
        { ttl: DOCUMENT_ACTIVITY_TTL_MS },
      );
      accessThrottle.set(throttleKey, true);
    }
  }
  return null;
}

export async function handleListRecentRequest(
  this: { subject?: string },
  opts: { limit?: number; max_age_s?: number; search?: string } | undefined,
  client: Client,
): Promise<RecentProjectDocumentActivityEntry[]> {
  const { account_id, project_id } = parseActivitySubject(this?.subject);
  assertCollaborator({ account_id, project_id });
  const store = await getRecentStore({ client, project_id });
  const nowMs = Date.now();
  const cutoffMs = nowMs - normalizeMaxAgeSeconds(opts?.max_age_s) * 1000;
  const search = compileSearchPattern(opts?.search);
  const rows: RecentProjectDocumentActivityEntry[] = [];
  for (const [path, row] of Object.entries(store.getAll())) {
    const lastAccessedMs = Date.parse(row?.last_accessed ?? "");
    if (!Number.isFinite(lastAccessedMs)) {
      store.delete(path);
      continue;
    }
    if (nowMs - lastAccessedMs > DOCUMENT_ACTIVITY_TTL_MS) {
      store.delete(path);
      continue;
    }
    if (lastAccessedMs < cutoffMs) {
      continue;
    }
    if (search && !search.test(path)) {
      continue;
    }
    rows.push({
      project_id,
      path,
      last_accessed: row.last_accessed,
      recent_account_ids: sortRecentAccounts(
        pruneRecentAccounts({
          recent_accounts: row.recent_accounts,
          nowMs,
        }),
      ),
    });
  }
  rows.sort((left, right) => {
    const a = Date.parse(left.last_accessed ?? "");
    const b = Date.parse(right.last_accessed ?? "");
    if (Number.isFinite(a) && Number.isFinite(b) && b !== a) {
      return b - a;
    }
    return left.path.localeCompare(right.path);
  });
  return rows.slice(0, normalizeLimit(opts?.limit));
}

// Browsers record document activity and open sync documents with absolute
// paths ("/home/user/lectures/a.ipynb"), while callers such as the course
// file-use export ask with home-relative paths ("lectures/a.ipynb"). Return
// the spellings of the same file, canonical absolute first.
export function fileUsePathVariants(path: string): string[] {
  const normalized = posix.normalize(path);
  // Home-relative form of the path, if it is under any known runtime home.
  let relative: string | undefined;
  if (!normalized.startsWith("/")) {
    relative = normalized;
  } else {
    for (const home of PROJECT_RUNTIME_HOME_ALIASES) {
      if (normalized.startsWith(`${home}/`)) {
        relative = normalized.slice(home.length + 1);
        break;
      }
    }
  }
  if (relative == null) {
    return [normalized];
  }
  // Canonical current home first, then the relative spelling, then legacy
  // homes (e.g. /root), so the normal case needs a single patch stream.
  const variants = [
    posix.join(DEFAULT_PROJECT_RUNTIME_HOME, relative),
    relative,
    ...PROJECT_RUNTIME_HOME_ALIASES.filter(
      (home) => home !== DEFAULT_PROJECT_RUNTIME_HOME,
    ).map((home) => posix.join(home, relative!)),
  ];
  return [...new Set(variants)];
}

export async function handleGetFileUseTimesRequest(
  this: { subject?: string },
  opts: {
    path: string;
    target_account_id?: string;
    limit?: number;
    access_times?: boolean;
    edit_times?: boolean;
  },
  client: Client,
): Promise<FileUseTimesResponse> {
  const { account_id, project_id } = parseActivitySubject(this?.subject);
  assertCollaborator({ account_id, project_id });
  const path = `${opts?.path ?? ""}`.trim();
  if (!path) {
    throw new Error("path must be specified");
  }
  const target_account_id = isValidUUID(
    `${opts?.target_account_id ?? ""}`.trim(),
  )
    ? `${opts?.target_account_id}`
    : account_id;
  const limit = Math.max(1, Math.min(10_000, Math.floor(opts?.limit ?? 1000)));
  const resp: FileUseTimesResponse = { target_account_id };
  const paths = fileUsePathVariants(path);

  if (opts?.access_times ?? true) {
    const stream = await getAccessStream({ client, project_id });
    const access_times: number[] = [];
    const messages = stream.getAll();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const event = messages[i];
      if (
        !paths.includes(event?.path) ||
        event?.account_id !== target_account_id
      ) {
        continue;
      }
      const when = Date.parse(`${event.time ?? ""}`);
      if (!Number.isFinite(when)) {
        continue;
      }
      access_times.push(when);
      if (access_times.length >= limit) {
        break;
      }
    }
    resp.access_times = access_times;
  }

  if (opts?.edit_times) {
    // Notebook patches belong to the syncdb, but access events use the visible
    // filename above. Patch times are document-wide, not per-account edits.
    // Read the canonical (absolute) history first; only fall back to the
    // other spelling when it has none, so the normal case opens one stream.
    resp.edit_times = [];
    for (const variant of paths) {
      const editPath = variant.endsWith(".ipynb")
        ? syncdbPath(variant)
        : variant;
      const patchStream = await dstream({
        project_id,
        name: patchesStreamName({ path: editPath }),
        noAutosave: true,
        noInventory: true,
        client,
      });
      let times: number[];
      try {
        times = patchStream
          .times()
          .map((t) => t?.valueOf())
          .filter((ms): ms is number => ms != null);
      } finally {
        patchStream.close();
      }
      if (times.length > 0) {
        resp.edit_times = [...new Set(times)].sort((a, b) => a - b);
        break;
      }
    }
  }

  return resp;
}

export async function initProjectDocumentActivityService(client: Client) {
  logger.debug("starting project document activity service", {
    subject: PROJECT_DOCUMENT_ACTIVITY_SUBJECT,
  });
  return await client.service(PROJECT_DOCUMENT_ACTIVITY_SUBJECT, {
    markFile(opts: { path: string; action: DocumentActivityAction }) {
      return handleMarkFileRequest.call(this, opts, client);
    },
    listRecent(opts: { limit?: number; max_age_s?: number; search?: string }) {
      return handleListRecentRequest.call(this, opts, client);
    },
    getFileUseTimes(opts: {
      path: string;
      target_account_id?: string;
      limit?: number;
      access_times?: boolean;
      edit_times?: boolean;
    }) {
      return handleGetFileUseTimesRequest.call(this, opts, client);
    },
  });
}
