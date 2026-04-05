/*
This is a very lightweight small subset of the hub's API for browser clients.
*/

import getLogger from "@cocalc/backend/logger";
import { getFrontendSourceFingerprint } from "@cocalc/backend/frontend-build-fingerprint";
import { type HubApi, getUserId, transformArgs } from "@cocalc/conat/hub/api";
import type {
  AccountBayLocation,
  AccountCollaboratorIndexProjectionDrainResult,
  AccountCollaboratorIndexProjectionStatus,
  AccountCollaboratorIndexRebuildResult,
  AccountNotificationIndexProjectionDrainResult,
  AccountNotificationIndexProjectionStatus,
  AccountNotificationIndexRebuildResult,
  AccountProjectIndexProjectionStatus,
  AccountProjectIndexProjectionDrainResult,
  AccountProjectIndexRebuildResult,
  BayInfo,
  BayOwnershipBackfillResult,
  CodexPaymentSourceInfo,
  HostBayLocation,
  ProjectBayLocation,
} from "@cocalc/conat/hub/api/system";
import type {
  ArchiveNotificationOptions,
  CreateAccountNoticeOptions,
  CreateMentionNotificationOptions,
  CreateNotificationResult,
  ListNotificationsOptions,
  MarkNotificationReadOptions,
  MarkNotificationReadResult,
  NotificationCountsResult,
  NotificationListRow,
  SaveNotificationOptions,
} from "@cocalc/conat/hub/api/notifications";
import type {
  ProjectLogCursor,
  ProjectLogPage,
  ProjectLogRow,
} from "@cocalc/conat/hub/api/projects";
import userQuery, { init as initUserQuery } from "./sqlite/user-query";
import { account_id as ACCOUNT_ID, data } from "@cocalc/backend/data";
import { project_id as LITE_PROJECT_ID } from "@cocalc/project/data";
import {
  FALLBACK_PROJECT_UUID,
  FALLBACK_ACCOUNT_UUID,
} from "@cocalc/util/misc";
import {
  callRemoteHub,
  hasRemote,
  project_id as REMOTE_PROJECT_ID,
} from "../remote";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { setSshUi, ssh } from "./ssh";
import { setReflectUi, reflect } from "./reflect";
import * as agent from "./agent";
import {
  history as syncHistory,
  purgeHistory as syncPurgeHistory,
} from "@cocalc/conat/hub/api/sync-impl";
import {
  listBrowserSessionsForAccount,
  removeBrowserSessionRecord,
  upsertBrowserSessionRecord,
} from "./browser-sessions";
import { getLiteServerSettings } from "./settings";
import {
  deleteChatStoreData,
  getChatStoreStats,
  listChatStoreSegments,
  readChatStoreArchived,
  readChatStoreArchivedHit,
  rotateChatStore,
  searchChatStoreArchived,
  vacuumChatStore,
} from "./sqlite/chat-offload";
import {
  startChatOffloadBackgroundMaintenance,
  stopChatOffloadBackgroundMaintenance,
} from "./chat-offload-maintenance";
import { getLiteConatClient } from "./runtime-client";
import {
  cancelLiteCodexDeviceAuth,
  getLiteCodexDeviceAuthStatus,
  resolveLiteCodexHome,
  startLiteCodexDeviceAuth,
  uploadLiteSubscriptionAuthFile,
} from "./codex-auth";
import { listRows } from "./sqlite/database";

const logger = getLogger("lite:hub:api");
const execFile = promisify(execFileCb);
const DEFAULT_BAY_ID = "bay-0";
const DEFAULT_PROJECT_LOG_LIMIT = 750;
const MAX_PROJECT_LOG_LIMIT = 2_000;

function syncHistoryWithExplicitClient(
  opts: Parameters<typeof syncHistory>[0],
) {
  return syncHistory({
    ...opts,
    client: getLiteConatClient(),
  });
}

function syncPurgeHistoryWithExplicitClient(
  opts: Parameters<typeof syncPurgeHistory>[0],
) {
  return syncPurgeHistory({
    ...opts,
    client: getLiteConatClient(),
  });
}

function parseMap(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const key in parsed) {
      const val = parsed[key];
      if (typeof val === "string" && val.trim()) {
        out[key] = val.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function getLiteBayId(): string {
  const bay_id = `${process.env.COCALC_BAY_ID ?? ""}`.trim();
  return bay_id || DEFAULT_BAY_ID;
}

function getLiteBayLabel(bay_id: string): string {
  const label = `${process.env.COCALC_BAY_LABEL ?? ""}`.trim();
  return label || bay_id;
}

function getLiteBayRegion(): string | null {
  const region = `${process.env.COCALC_BAY_REGION ?? ""}`.trim();
  return region || null;
}

export function getSingleLiteBayInfo(): BayInfo {
  const bay_id = getLiteBayId();
  return {
    bay_id,
    label: getLiteBayLabel(bay_id),
    region: getLiteBayRegion(),
    deployment_mode: "single-bay",
    role: "combined",
    is_default: true,
  };
}

function resolveLiteProjectId(value?: string): string {
  const explicit = `${value ?? ""}`.trim();
  if (explicit) return explicit;
  const remoteProjectId = `${REMOTE_PROJECT_ID ?? ""}`.trim();
  if (remoteProjectId) return remoteProjectId;
  const localProjectId = `${LITE_PROJECT_ID ?? ""}`.trim();
  if (localProjectId) return localProjectId;
  return FALLBACK_PROJECT_UUID;
}

function requireLiteAccountId(value?: string): string {
  const account_id = `${value ?? ACCOUNT_ID}`.trim() || ACCOUNT_ID;
  if (!account_id) {
    throw Error("user must be signed in");
  }
  return account_id;
}

function requireLiteProjectId(value?: string): string {
  const expected = resolveLiteProjectId();
  const explicit = `${value ?? ""}`.trim();
  const project_id = explicit || expected;
  if (expected && project_id !== expected) {
    throw Error(`project '${project_id}' is not available in lite mode`);
  }
  return project_id;
}

function normalizeProjectLogLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_PROJECT_LOG_LIMIT;
  }
  return Math.max(1, Math.min(MAX_PROJECT_LOG_LIMIT, Math.floor(limit!)));
}

function normalizeProjectLogTime(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(`${value}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function projectLogCursorKey(
  cursor?: ProjectLogCursor,
): [number, string] | null {
  if (!cursor?.id) return null;
  return [normalizeProjectLogTime(cursor.time)?.getTime() ?? 0, cursor.id];
}

function compareProjectLogRows(a: ProjectLogRow, b: ProjectLogRow): number {
  const at = normalizeProjectLogTime(a.time)?.getTime() ?? 0;
  const bt = normalizeProjectLogTime(b.time)?.getTime() ?? 0;
  if (at !== bt) return bt - at;
  return `${b.id}`.localeCompare(`${a.id}`);
}

async function listProjectLogLite(opts: {
  account_id?: string;
  project_id: string;
  limit?: number;
  newer_than?: ProjectLogCursor;
  older_than?: ProjectLogCursor;
}): Promise<ProjectLogPage> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "projects.listProjectLog",
      args: [opts],
    });
  }
  const project_id = requireLiteProjectId(opts.project_id);
  const limit = normalizeProjectLogLimit(opts.limit);
  const newerKey = projectLogCursorKey(opts.newer_than);
  const olderKey = projectLogCursorKey(opts.older_than);

  const entries = (listRows("project_log") as any[])
    .filter((row) => row?.project_id === project_id)
    .map(
      (row): ProjectLogRow => ({
        id: `${row.id}`,
        project_id: `${row.project_id}`,
        account_id: `${row.account_id}`,
        time: normalizeProjectLogTime(row.time),
        event: row.event ?? {},
      }),
    )
    .sort(compareProjectLogRows)
    .filter((row) => {
      const key: [number, string] = [
        normalizeProjectLogTime(row.time)?.getTime() ?? 0,
        row.id,
      ];
      if (
        newerKey != null &&
        (key[0] < newerKey[0] ||
          (key[0] === newerKey[0] && key[1] <= newerKey[1]))
      ) {
        return false;
      }
      if (
        olderKey != null &&
        (key[0] > olderKey[0] ||
          (key[0] === olderKey[0] && key[1] >= olderKey[1]))
      ) {
        return false;
      }
      return true;
    });

  return {
    entries: entries.slice(0, limit),
    has_more: entries.length > limit,
  };
}

async function codexDeviceAuthStartLite(opts: {
  account_id?: string;
  project_id?: string;
}) {
  if (hasRemote) {
    return await callRemoteHub({
      name: "projects.codexDeviceAuthStart",
      args: [opts],
    });
  }
  const account_id = requireLiteAccountId(opts.account_id);
  const project_id = requireLiteProjectId(opts.project_id);
  return await startLiteCodexDeviceAuth({
    projectId: project_id,
    accountId: account_id,
  });
}

async function codexDeviceAuthStatusLite(opts: {
  account_id?: string;
  project_id?: string;
  id: string;
}) {
  if (hasRemote) {
    return await callRemoteHub({
      name: "projects.codexDeviceAuthStatus",
      args: [opts],
    });
  }
  const account_id = requireLiteAccountId(opts.account_id);
  const project_id = requireLiteProjectId(opts.project_id);
  const id = `${opts.id ?? ""}`.trim();
  const status = getLiteCodexDeviceAuthStatus(id);
  if (
    !status ||
    status.accountId !== account_id ||
    status.projectId !== project_id
  ) {
    throw Error("unknown device auth id");
  }
  return status;
}

async function codexDeviceAuthCancelLite(opts: {
  account_id?: string;
  project_id?: string;
  id: string;
}) {
  if (hasRemote) {
    return await callRemoteHub({
      name: "projects.codexDeviceAuthCancel",
      args: [opts],
    });
  }
  const account_id = requireLiteAccountId(opts.account_id);
  const project_id = requireLiteProjectId(opts.project_id);
  const id = `${opts.id ?? ""}`.trim();
  const status = getLiteCodexDeviceAuthStatus(id);
  if (
    !status ||
    status.accountId !== account_id ||
    status.projectId !== project_id
  ) {
    throw Error("unknown device auth id");
  }
  return { id, canceled: cancelLiteCodexDeviceAuth(id) };
}

async function codexUploadAuthFileLite(opts: {
  account_id?: string;
  project_id?: string;
  filename?: string;
  content: string;
}) {
  if (hasRemote) {
    return await callRemoteHub({
      name: "projects.codexUploadAuthFile",
      args: [opts],
    });
  }
  requireLiteAccountId(opts.account_id);
  requireLiteProjectId(opts.project_id);
  if (opts.filename && !/auth\.json$/i.test(opts.filename.trim())) {
    throw Error("only auth.json uploads are supported");
  }
  const result = await uploadLiteSubscriptionAuthFile({
    content: opts.content,
  });
  return { ok: true as const, ...result };
}

async function hasLocalSubscriptionAuth(codexHome: string): Promise<boolean> {
  const authPath = join(codexHome, "auth.json");
  try {
    const raw = await readFile(authPath, "utf8");
    if (!raw.trim()) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

function getEnvOpenAiApiKey(): string | undefined {
  const candidates = [
    process.env.OPENAI_API_KEY,
    process.env.COCALC_OPENAI_API_KEY,
    process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEY,
  ];
  for (const value of candidates) {
    const trimmed = `${value ?? ""}`.trim();
    if (trimmed) return trimmed;
  }
}

async function getCodexPaymentSource(opts?: {
  account_id?: string;
  project_id?: string;
}): Promise<CodexPaymentSourceInfo> {
  const account_id = `${opts?.account_id ?? ACCOUNT_ID}`.trim() || ACCOUNT_ID;
  const project_id = `${opts?.project_id ?? ""}`.trim() || undefined;
  const codexHome = resolveLiteCodexHome();
  const hasSubscription = await hasLocalSubscriptionAuth(codexHome);

  const projectKeys = parseMap(
    process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEYS_JSON,
  );
  const hasProjectApiKey =
    !!(project_id && projectKeys[project_id]) ||
    !!(
      project_id &&
      `${process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEY ?? ""}`.trim()
    );
  const accountKeys = parseMap(
    process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEYS_JSON,
  );
  const hasAccountApiKey = !!getEnvOpenAiApiKey() || !!accountKeys[account_id];
  const settings = getLiteServerSettings();
  const acpMockMode = `${process.env.COCALC_ACP_MODE ?? ""}`.trim() === "mock";
  const hasSiteApiKey =
    acpMockMode ||
    (!!settings?.openai_enabled &&
      !!`${settings?.openai_api_key ?? ""}`.trim());

  let source: CodexPaymentSourceInfo["source"] = "none";
  if (hasSubscription) {
    source = "subscription";
  } else if (hasProjectApiKey) {
    source = "project-api-key";
  } else if (hasAccountApiKey) {
    source = "account-api-key";
  } else if (hasSiteApiKey) {
    source = "site-api-key";
  }

  return {
    source,
    hasSubscription,
    hasProjectApiKey,
    hasAccountApiKey,
    hasSiteApiKey,
    // Lite always runs against a local/shared home.
    sharedHomeMode: "always",
    project_id,
  };
}

async function getCodexLocalStatus(): Promise<{
  installed: boolean;
  binaryPath?: string;
  version?: string;
  error?: string;
  checkedAt: number;
}> {
  const configured = `${process.env.COCALC_CODEX_BIN ?? ""}`.trim();
  const binaryPath = configured || "codex";
  const checkedAt = Date.now();
  try {
    const { stdout, stderr } = await execFile(binaryPath, ["--version"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    const version = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line);
    return {
      installed: true,
      binaryPath,
      version,
      checkedAt,
    };
  } catch (err) {
    const details =
      (err as any)?.stderr ||
      (err as any)?.message ||
      (err as any)?.code ||
      `${err}`;
    return {
      installed: false,
      binaryPath,
      error: `${details}`.trim(),
      checkedAt,
    };
  }
}

async function getFrontendSourceFingerprintInfo() {
  return await getFrontendSourceFingerprint();
}

export async function init({
  client,
  sshUi,
  reflectUi,
}: {
  client;
  sshUi?: any;
  reflectUi?: any;
}) {
  const subject = "hub.*.*.api";
  const filename = join(data, "hub.db");
  logger.debug(`init -- subject='${subject}', options=`, {
    queue: "0",
    filename,
  });
  if (sshUi) {
    setSshUi(sshUi);
  }
  if (reflectUi) {
    setReflectUi(reflectUi);
  }
  startChatOffloadBackgroundMaintenance();
  process.once("exit", () => {
    stopChatOffloadBackgroundMaintenance();
  });
  await initUserQuery({ filename });
  const api = await client.subscribe(subject, { queue: "0" });
  listen(api, client);
}

async function listen(api, client) {
  for await (const mesg of api) {
    (async () => {
      try {
        await handleMessage(mesg, client);
      } catch (err) {
        logger.debug(`WARNING: unexpected error  - ${err}`);
      }
    })();
  }
}

async function handleMessage(mesg, client) {
  const request = mesg.data ?? ({} as any);
  let resp, headers;
  try {
    let account_id: string | undefined;
    let project_id: string | undefined;
    let host_id: string | undefined;
    try {
      ({ account_id, project_id, host_id } = getUserId(mesg.subject));
    } catch {
      // Keep legacy fallback behavior if subject parsing fails unexpectedly.
      account_id = ACCOUNT_ID;
      project_id = undefined;
      host_id = undefined;
    }
    const { name, args } = request as any;
    logger.debug("handling hub.api request:", {
      account_id,
      project_id,
      host_id,
      name,
    });
    resp =
      (await getResponse({
        name,
        args,
        account_id,
        project_id,
        host_id,
        client,
      })) ?? null;
    headers = undefined;
  } catch (err) {
    resp = null;
    headers = {
      error: err.message ? err.message : `${err}`,
      error_attrs: { code: err.code, subject: err.subject },
    };
  }
  try {
    await mesg.respond(resp, { headers });
  } catch (err) {
    // there's nothing we can do here, e.g., maybe NATS just died.
    logger.debug(
      `WARNING: error responding to hub.api request (client will receive no response) -- ${err}`,
    );
  }
}

function fallbackNames(account_ids: Set<string>): {
  [id: string]: { first_name: string; last_name: string };
} {
  const names: { [id: string]: { first_name: string; last_name: string } } = {};
  if (account_ids.has(FALLBACK_PROJECT_UUID)) {
    names[FALLBACK_PROJECT_UUID] = {
      first_name: "CoCalc",
      last_name: "Project",
    };
  }
  if (account_ids.has(FALLBACK_ACCOUNT_UUID)) {
    names[FALLBACK_ACCOUNT_UUID] = { first_name: "CoCalc", last_name: "User" };
  }
  if (account_ids.has(ACCOUNT_ID)) {
    names[ACCOUNT_ID] = { first_name: "CoCalc", last_name: "User" };
  }
  if (account_ids.has(REMOTE_PROJECT_ID)) {
    // TODO: get the actual project title (?).
    names[REMOTE_PROJECT_ID] = { first_name: "Remote", last_name: "Project" };
  }
  return names;
}

async function getNames(account_ids: string[]) {
  const x = fallbackNames(new Set(account_ids));
  if (!hasRemote) {
    return x;
  }
  const names = await callRemoteHub({
    name: "system.getNames",
    args: [account_ids],
  });
  return { ...names, ...x };
}

async function logClientError(_opts?: { event?: string; error?: string }) {
  // No-op in lite mode.
}

async function userTracking(_opts?: { event?: string; value?: object }) {
  // No-op in lite mode.
}

async function webappError(_opts?: object) {
  // No-op in lite mode.
}

export async function listBaysLite(opts?: {
  account_id?: string;
}): Promise<BayInfo[]> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.listBays",
      args: [opts ?? {}],
    });
  }
  return [getSingleLiteBayInfo()];
}

export async function getAccountBayLite(opts?: {
  account_id?: string;
  user_account_id?: string;
}): Promise<AccountBayLocation> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.getAccountBay",
      args: [opts ?? {}],
    });
  }
  const account_id =
    `${opts?.user_account_id ?? opts?.account_id ?? ACCOUNT_ID}`.trim() ||
    ACCOUNT_ID;
  return {
    account_id,
    home_bay_id: getLiteBayId(),
    source: "single-bay-default",
  };
}

export async function getProjectBayLite(opts?: {
  account_id?: string;
  project_id?: string;
}): Promise<ProjectBayLocation> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.getProjectBay",
      args: [opts ?? {}],
    });
  }
  return {
    project_id: resolveLiteProjectId(opts?.project_id),
    owning_bay_id: getLiteBayId(),
    host_id: null,
    title: "",
    source: "single-bay-default",
  };
}

export async function getHostBayLite(opts?: {
  account_id?: string;
  host_id?: string;
}): Promise<HostBayLocation> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.getHostBay",
      args: [opts ?? {}],
    });
  }
  const host_id = `${opts?.host_id ?? ""}`.trim();
  if (!host_id) {
    throw Error("host_id is required");
  }
  return {
    host_id,
    bay_id: getLiteBayId(),
    name: host_id,
    source: "single-bay-default",
  };
}

export async function backfillBayOwnershipLite(opts?: {
  account_id?: string;
  bay_id?: string;
  dry_run?: boolean;
  limit_per_table?: number;
}): Promise<BayOwnershipBackfillResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.backfillBayOwnership",
      args: [opts ?? {}],
    });
  }
  const bay_id = `${opts?.bay_id ?? ""}`.trim() || getLiteBayId();
  return {
    bay_id,
    dry_run: opts?.dry_run ?? true,
    limit_per_table:
      typeof opts?.limit_per_table === "number" ? opts.limit_per_table : null,
    accounts_missing: 0,
    projects_missing: 0,
    hosts_missing: 0,
    accounts_updated: 0,
    projects_updated: 0,
    hosts_updated: 0,
  };
}

export async function rebuildAccountProjectIndexLite(opts?: {
  account_id?: string;
  target_account_id?: string;
  dry_run?: boolean;
}): Promise<AccountProjectIndexRebuildResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.rebuildAccountProjectIndex",
      args: [opts ?? {}],
    });
  }
  throw new Error(
    "account_project_index rebuild requires a remote hub connection",
  );
}

export async function drainAccountProjectIndexProjectionLite(opts?: {
  account_id?: string;
  bay_id?: string;
  limit?: number;
  dry_run?: boolean;
}): Promise<AccountProjectIndexProjectionDrainResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.drainAccountProjectIndexProjection",
      args: [opts ?? {}],
    });
  }
  throw new Error(
    "account_project_index projector drain requires a remote hub connection",
  );
}

export async function getAccountProjectIndexProjectionStatusLite(opts?: {
  account_id?: string;
}): Promise<AccountProjectIndexProjectionStatus> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.getAccountProjectIndexProjectionStatus",
      args: [opts ?? {}],
    });
  }
  throw new Error(
    "account_project_index projector status requires a remote hub connection",
  );
}

export async function rebuildAccountCollaboratorIndexLite(opts?: {
  account_id?: string;
  target_account_id?: string;
  dry_run?: boolean;
}): Promise<AccountCollaboratorIndexRebuildResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.rebuildAccountCollaboratorIndex",
      args: [opts ?? {}],
    });
  }
  throw new Error(
    "account_collaborator_index rebuild requires a remote hub connection",
  );
}

export async function drainAccountCollaboratorIndexProjectionLite(opts?: {
  account_id?: string;
  bay_id?: string;
  limit?: number;
  dry_run?: boolean;
}): Promise<AccountCollaboratorIndexProjectionDrainResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.drainAccountCollaboratorIndexProjection",
      args: [opts ?? {}],
    });
  }
  throw new Error(
    "account_collaborator_index projector drain requires a remote hub connection",
  );
}

export async function getAccountCollaboratorIndexProjectionStatusLite(opts?: {
  account_id?: string;
}): Promise<AccountCollaboratorIndexProjectionStatus> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.getAccountCollaboratorIndexProjectionStatus",
      args: [opts ?? {}],
    });
  }
  throw new Error(
    "account_collaborator_index projector status requires a remote hub connection",
  );
}

export async function rebuildAccountNotificationIndexLite(opts?: {
  account_id?: string;
  target_account_id?: string;
  dry_run?: boolean;
}): Promise<AccountNotificationIndexRebuildResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.rebuildAccountNotificationIndex",
      args: [opts ?? {}],
    });
  }
  throw new Error(
    "account_notification_index rebuild requires a remote hub connection",
  );
}

export async function drainAccountNotificationIndexProjectionLite(opts?: {
  account_id?: string;
  bay_id?: string;
  limit?: number;
  dry_run?: boolean;
}): Promise<AccountNotificationIndexProjectionDrainResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.drainAccountNotificationIndexProjection",
      args: [opts ?? {}],
    });
  }
  throw new Error(
    "account_notification_index projector drain requires a remote hub connection",
  );
}

export async function getAccountNotificationIndexProjectionStatusLite(opts?: {
  account_id?: string;
}): Promise<AccountNotificationIndexProjectionStatus> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "system.getAccountNotificationIndexProjectionStatus",
      args: [opts ?? {}],
    });
  }
  throw new Error(
    "account_notification_index projector status requires a remote hub connection",
  );
}

async function upsertBrowserSession(opts?: {
  account_id?: string;
  browser_id: string;
  session_name?: string;
  url?: string;
  spawn_marker?: string;
  active_project_id?: string;
  open_projects?: any[];
}): Promise<{ browser_id: string; created_at: string; updated_at: string }> {
  const account_id = `${opts?.account_id ?? ACCOUNT_ID}`;
  return upsertBrowserSessionRecord({
    account_id,
    browser_id: `${opts?.browser_id ?? ""}`,
    session_name: opts?.session_name,
    url: opts?.url,
    spawn_marker: opts?.spawn_marker,
    active_project_id: opts?.active_project_id,
    open_projects: opts?.open_projects,
  });
}

async function listBrowserSessions(opts?: {
  account_id?: string;
  max_age_ms?: number;
  include_stale?: boolean;
}) {
  const account_id = `${opts?.account_id ?? ACCOUNT_ID}`;
  return listBrowserSessionsForAccount({
    account_id,
    max_age_ms: opts?.max_age_ms,
    include_stale: opts?.include_stale,
  });
}

async function removeBrowserSession(opts?: {
  account_id?: string;
  browser_id: string;
}): Promise<{ removed: boolean }> {
  const account_id = `${opts?.account_id ?? ACCOUNT_ID}`;
  return {
    removed: removeBrowserSessionRecord({
      account_id,
      browser_id: `${opts?.browser_id ?? ""}`,
    }),
  };
}

async function getManagedRootfsReleaseArtifact(opts?: {
  host_id?: string;
  image: string;
}) {
  if (!hasRemote) {
    throw new Error(
      "managed RootFS release artifacts require a remote hub connection",
    );
  }
  return await callRemoteHub({
    name: "hosts.getManagedRootfsReleaseArtifact",
    args: [opts ?? {}],
  });
}

async function listManagedRootfsReleaseLifecycle(opts?: {
  host_id?: string;
  images: string[];
}) {
  if (!hasRemote) {
    throw new Error(
      "managed RootFS release lifecycle requires a remote hub connection",
    );
  }
  return await callRemoteHub({
    name: "hosts.listManagedRootfsReleaseLifecycle",
    args: [opts ?? {}],
  });
}

async function issueBrowserSignInCookie(opts?: {
  account_id?: string;
  max_age_ms?: number;
}) {
  return {
    account_id: `${opts?.account_id ?? ACCOUNT_ID}`,
    max_age_ms: opts?.max_age_ms,
  };
}

async function createMentionLite(
  opts: CreateMentionNotificationOptions,
): Promise<CreateNotificationResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "notifications.createMention",
      args: [opts],
    });
  }
  throw Error(
    "notifications.createMention requires a remote hub connection in lite mode",
  );
}

async function createAccountNoticeLite(
  opts: CreateAccountNoticeOptions,
): Promise<CreateNotificationResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "notifications.createAccountNotice",
      args: [opts],
    });
  }
  throw Error(
    "notifications.createAccountNotice requires a remote hub connection in lite mode",
  );
}

async function listNotificationsLite(
  opts?: ListNotificationsOptions,
): Promise<NotificationListRow[]> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "notifications.list",
      args: [opts ?? {}],
    });
  }
  throw Error(
    "notifications.list requires a remote hub connection in lite mode",
  );
}

async function getNotificationCountsLite(opts?: {
  account_id?: string;
}): Promise<NotificationCountsResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "notifications.counts",
      args: [opts ?? {}],
    });
  }
  throw Error(
    "notifications.counts requires a remote hub connection in lite mode",
  );
}

async function markNotificationReadLite(
  opts: MarkNotificationReadOptions,
): Promise<MarkNotificationReadResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "notifications.markRead",
      args: [opts],
    });
  }
  throw Error(
    "notifications.markRead requires a remote hub connection in lite mode",
  );
}

async function saveNotificationLite(
  opts: SaveNotificationOptions,
): Promise<MarkNotificationReadResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "notifications.save",
      args: [opts],
    });
  }
  throw Error(
    "notifications.save requires a remote hub connection in lite mode",
  );
}

async function archiveNotificationLite(
  opts: ArchiveNotificationOptions,
): Promise<MarkNotificationReadResult> {
  if (hasRemote) {
    return await callRemoteHub({
      name: "notifications.archive",
      args: [opts],
    });
  }
  throw Error(
    "notifications.archive requires a remote hub connection in lite mode",
  );
}

// NOTE: Consumers (e.g., project-host) may extend this object in-place to add
// host-specific implementations of hub APIs. Keep the defaults minimal here.
export const hubApi: HubApi = {
  system: {
    getNames,
    listBays: listBaysLite,
    getAccountBay: getAccountBayLite,
    getProjectBay: getProjectBayLite,
    getHostBay: getHostBayLite,
    backfillBayOwnership: backfillBayOwnershipLite,
    rebuildAccountProjectIndex: rebuildAccountProjectIndexLite,
    drainAccountProjectIndexProjection: drainAccountProjectIndexProjectionLite,
    getAccountProjectIndexProjectionStatus:
      getAccountProjectIndexProjectionStatusLite,
    rebuildAccountCollaboratorIndex: rebuildAccountCollaboratorIndexLite,
    drainAccountCollaboratorIndexProjection:
      drainAccountCollaboratorIndexProjectionLite,
    getAccountCollaboratorIndexProjectionStatus:
      getAccountCollaboratorIndexProjectionStatusLite,
    rebuildAccountNotificationIndex: rebuildAccountNotificationIndexLite,
    drainAccountNotificationIndexProjection:
      drainAccountNotificationIndexProjectionLite,
    getAccountNotificationIndexProjectionStatus:
      getAccountNotificationIndexProjectionStatusLite,
    getCodexPaymentSource,
    getCodexLocalStatus,
    getFrontendSourceFingerprint: getFrontendSourceFingerprintInfo,
    logClientError,
    userTracking,
    webappError,
    upsertBrowserSession,
    listBrowserSessions,
    removeBrowserSession,
    issueBrowserSignInCookie,
  },
  hosts: {
    getManagedRootfsReleaseArtifact,
    listManagedRootfsReleaseLifecycle,
  },
  notifications: {
    createMention: createMentionLite,
    createAccountNotice: createAccountNoticeLite,
    list: listNotificationsLite,
    counts: getNotificationCountsLite,
    markRead: markNotificationReadLite,
    save: saveNotificationLite,
    archive: archiveNotificationLite,
  },
  projects: {
    listProjectLog: listProjectLogLite,
    codexDeviceAuthStart: codexDeviceAuthStartLite,
    codexDeviceAuthStatus: codexDeviceAuthStatusLite,
    codexDeviceAuthCancel: codexDeviceAuthCancelLite,
    codexUploadAuthFile: codexUploadAuthFileLite,
    chatStoreStats: async (opts: { chat_path: string; db_path?: string }) => {
      return await getChatStoreStats({
        chat_path: opts.chat_path,
        db_path: opts.db_path,
      });
    },
    chatStoreRotate: async (opts: {
      chat_path: string;
      db_path?: string;
      keep_recent_messages?: number;
      max_head_bytes?: number;
      max_head_messages?: number;
      require_idle?: boolean;
      force?: boolean;
      dry_run?: boolean;
    }) => {
      return await rotateChatStore({
        chat_path: opts.chat_path,
        db_path: opts.db_path,
        keep_recent_messages: opts.keep_recent_messages,
        max_head_bytes: opts.max_head_bytes,
        max_head_messages: opts.max_head_messages,
        require_idle: opts.require_idle,
        force: opts.force,
        dry_run: opts.dry_run,
      });
    },
    chatStoreListSegments: (opts: {
      chat_path: string;
      db_path?: string;
      limit?: number;
      offset?: number;
    }) => {
      return listChatStoreSegments({
        chat_path: opts.chat_path,
        db_path: opts.db_path,
        limit: opts.limit,
        offset: opts.offset,
      });
    },
    chatStoreReadArchived: (opts: {
      chat_path: string;
      db_path?: string;
      before_date_ms?: number;
      thread_id?: string;
      limit?: number;
      offset?: number;
    }) => {
      return readChatStoreArchived({
        chat_path: opts.chat_path,
        db_path: opts.db_path,
        before_date_ms: opts.before_date_ms,
        thread_id: opts.thread_id,
        limit: opts.limit,
        offset: opts.offset,
      });
    },
    chatStoreReadArchivedHit: (opts: {
      chat_path: string;
      db_path?: string;
      row_id?: number;
      message_id?: string;
      thread_id?: string;
    }) => {
      return readChatStoreArchivedHit({
        chat_path: opts.chat_path,
        db_path: opts.db_path,
        row_id: opts.row_id,
        message_id: opts.message_id,
        thread_id: opts.thread_id,
      });
    },
    chatStoreSearch: (opts: {
      chat_path: string;
      query: string;
      db_path?: string;
      thread_id?: string;
      exclude_thread_ids?: string[];
      limit?: number;
      offset?: number;
    }) => {
      return searchChatStoreArchived({
        chat_path: opts.chat_path,
        query: opts.query,
        db_path: opts.db_path,
        thread_id: opts.thread_id,
        exclude_thread_ids: opts.exclude_thread_ids,
        limit: opts.limit,
        offset: opts.offset,
      });
    },
    chatStoreDelete: (opts: {
      chat_path: string;
      db_path?: string;
      scope: "chat" | "before_date" | "thread" | "messages";
      before_date_ms?: number;
      thread_id?: string;
      message_ids?: string[];
    }) => {
      return deleteChatStoreData({
        chat_path: opts.chat_path,
        db_path: opts.db_path,
        scope: opts.scope,
        before_date_ms: opts.before_date_ms,
        thread_id: opts.thread_id,
        message_ids: opts.message_ids,
      });
    },
    chatStoreVacuum: (opts: { chat_path: string; db_path?: string }) => {
      return vacuumChatStore({
        chat_path: opts.chat_path,
        db_path: opts.db_path,
      });
    },
  },
  db: { touch: () => {}, userQuery },
  purchases: {},
  agent,
  sync: {
    history: syncHistoryWithExplicitClient,
    purgeHistory: syncPurgeHistoryWithExplicitClient,
  },
  jupyter: {},
  ssh,
  reflect,
} as any;

async function getResponse({
  name,
  args,
  account_id,
  project_id,
  host_id,
  client,
}) {
  const [group, functionName] = name.split(".");
  if (functionName == "getSshKeys") {
    // no ssh keys in lite mode for now...
    return [];
  }
  const f = hubApi[group]?.[functionName];
  if (f == null) {
    throw Error(`not implemented function '${name}'`);
  }
  const args2 = await transformArgs({
    name,
    args,
    account_id,
    project_id,
    host_id,
  });
  if (group === "sync" && args2?.[0] != null) {
    args2[0].client = client;
  }
  return await f(...args2);
}
