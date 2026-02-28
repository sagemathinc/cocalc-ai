/*
This is a very lightweight small subset of the hub's API for browser clients.
*/

import getLogger from "@cocalc/backend/logger";
import { type HubApi, getUserId, transformArgs } from "@cocalc/conat/hub/api";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import userQuery, { init as initUserQuery } from "./sqlite/user-query";
import { account_id as ACCOUNT_ID, data } from "@cocalc/backend/data";
import {
  FALLBACK_PROJECT_UUID,
  FALLBACK_ACCOUNT_UUID,
} from "@cocalc/util/misc";
import { callRemoteHub, hasRemote, project_id } from "../remote";
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
  rotateChatStore,
  searchChatStoreArchived,
  vacuumChatStore,
} from "./sqlite/chat-offload";

const logger = getLogger("lite:hub:api");
const execFile = promisify(execFileCb);

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

function resolveLiteCodexHome(): string {
  const configured = `${process.env.COCALC_CODEX_HOME ?? ""}`.trim();
  if (configured) return configured;
  const home = `${process.env.HOME ?? ""}`.trim();
  if (home) return join(home, ".codex");
  return join(process.cwd(), ".codex");
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
    !!(project_id && `${process.env.COCALC_CODEX_AUTH_PROJECT_OPENAI_KEY ?? ""}`.trim());
  const accountKeys = parseMap(
    process.env.COCALC_CODEX_AUTH_ACCOUNT_OPENAI_KEYS_JSON,
  );
  const hasAccountApiKey =
    !!getEnvOpenAiApiKey() || !!accountKeys[account_id];
  const settings = getLiteServerSettings();
  const acpMockMode = `${process.env.COCALC_ACP_MODE ?? ""}`.trim() === "mock";
  const hasSiteApiKey =
    acpMockMode ||
    (!!settings?.openai_enabled && !!`${settings?.openai_api_key ?? ""}`.trim());

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
  if (account_ids.has(project_id)) {
    // TODO: get the actual project title (?).
    names[project_id] = { first_name: "Remote", last_name: "Project" };
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

async function upsertBrowserSession(opts?: {
  account_id?: string;
  browser_id: string;
  session_name?: string;
  url?: string;
  active_project_id?: string;
  open_projects?: any[];
}): Promise<{ browser_id: string; created_at: string; updated_at: string }> {
  const account_id = `${opts?.account_id ?? ACCOUNT_ID}`;
  return upsertBrowserSessionRecord({
    account_id,
    browser_id: `${opts?.browser_id ?? ""}`,
    session_name: opts?.session_name,
    url: opts?.url,
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

// NOTE: Consumers (e.g., project-host) may extend this object in-place to add
// host-specific implementations of hub APIs. Keep the defaults minimal here.
export const hubApi: HubApi = {
  system: {
    getNames,
    getCodexPaymentSource,
    getCodexLocalStatus,
    logClientError,
    userTracking,
    webappError,
    upsertBrowserSession,
    listBrowserSessions,
    removeBrowserSession,
  },
  projects: {
    chatStoreStats: async (opts: {
      chat_path: string;
      db_path?: string;
    }) => {
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
    chatStoreVacuum: (opts: {
      chat_path: string;
      db_path?: string;
    }) => {
      return vacuumChatStore({
        chat_path: opts.chat_path,
        db_path: opts.db_path,
      });
    },
  },
  db: { touch: () => {}, userQuery },
  purchases: {},
  agent,
  sync: { history: syncHistory, purgeHistory: syncPurgeHistory },
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
