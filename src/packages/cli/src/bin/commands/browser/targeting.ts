/*
Browser session/profile/target resolution helpers.

These helpers centralize browser-id selection, profile persistence, and
workspace/project targeting logic used by browser command registrars.
*/

import type { Command } from "commander";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";
import { isValidUUID } from "@cocalc/util/misc";
import { normalizeBrowserId } from "./parse-format";
import {
  nowIso,
  resolveSpawnStateByBrowserId,
  sessionMatchesSpawnMarker,
  spawnMarkerFromUrl,
  writeSpawnState,
} from "./spawn-state";
import type {
  BrowserCommandContext,
  BrowserCommandDeps,
  BrowserProfileSelection,
} from "./types";

function isLikelyExactBrowserId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,}$/.test(value);
}

function directBrowserSessionInfo(browser_id: string): BrowserSessionInfo {
  const now = new Date().toISOString();
  return {
    browser_id,
    open_projects: [],
    stale: false,
    created_at: now,
    updated_at: now,
  };
}

function normalizeApiScope(value: unknown): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

export function browserHintFromOption(value: unknown): string | undefined {
  return (
    normalizeBrowserId(value) ?? normalizeBrowserId(process.env.COCALC_BROWSER_ID)
  );
}

export function resolveBrowserSession(
  sessions: BrowserSessionInfo[],
  browserHint: string,
): BrowserSessionInfo {
  const exact = sessions.find((s) => s.browser_id === browserHint);
  if (exact) return exact;
  const prefixed = sessions.filter((s) => s.browser_id.startsWith(browserHint));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new Error(
      `browser id '${browserHint}' is ambiguous (${prefixed.length} matches)`,
    );
  }
  throw new Error(`browser session '${browserHint}' not found`);
}

export function sessionMatchesProject(
  session: BrowserSessionInfo,
  projectId: string | undefined,
): boolean {
  const target = `${projectId ?? ""}`.trim();
  if (!target) return true;
  if (`${session.active_project_id ?? ""}`.trim() === target) {
    return true;
  }
  return (session.open_projects ?? []).some(
    (p) => `${p?.project_id ?? ""}`.trim() === target,
  );
}

export function sessionTargetContext(
  ctx: BrowserCommandContext,
  sessionInfo: BrowserSessionInfo,
  project_id?: string,
): Record<string, unknown> {
  const apiUrl = `${ctx?.apiBaseUrl ?? ""}`.trim();
  const sessionUrl = `${sessionInfo?.url ?? ""}`.trim();
  let target_warning = "";
  if (apiUrl && sessionUrl) {
    try {
      const apiOrigin = new URL(apiUrl).origin;
      const sessionOrigin = new URL(sessionUrl).origin;
      if (apiOrigin !== sessionOrigin) {
        target_warning =
          `browser session URL origin (${sessionOrigin}) differs from API origin (${apiOrigin})`;
      }
    } catch {
      // ignore parse failures
    }
  }
  return {
    target_api_url: apiUrl,
    target_browser_id: sessionInfo.browser_id,
    target_session_url: sessionUrl,
    ...(project_id ? { target_project_id: project_id } : {}),
    ...(target_warning ? { target_warning } : {}),
  };
}

export async function resolveTargetProjectId({
  deps,
  ctx,
  workspace,
  projectId,
  sessionInfo,
}: {
  deps: Pick<BrowserCommandDeps, "resolveWorkspace">;
  ctx: Parameters<BrowserCommandDeps["resolveWorkspace"]>[0];
  workspace?: string;
  projectId?: string;
  sessionInfo: BrowserSessionInfo;
}): Promise<string> {
  const projectIdHint = `${projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
  const workspaceHint = `${workspace ?? ""}`.trim();
  if (projectIdHint) {
    return isValidUUID(projectIdHint)
      ? projectIdHint
      : (await deps.resolveWorkspace(ctx, projectIdHint)).project_id;
  }
  if (workspaceHint) {
    return (await deps.resolveWorkspace(ctx, workspaceHint)).project_id;
  }
  const activeProjectId = `${sessionInfo.active_project_id ?? ""}`.trim();
  if (activeProjectId) {
    return (await deps.resolveWorkspace(ctx, activeProjectId)).project_id;
  }
  if (sessionInfo.open_projects?.length === 1 && sessionInfo.open_projects[0]?.project_id) {
    return (
      await deps.resolveWorkspace(ctx, sessionInfo.open_projects[0].project_id)
    ).project_id;
  }
  throw new Error(
    "workspace/project is required; pass --project-id, -w/--workspace, or focus a workspace tab in the target browser session",
  );
}

export function loadProfileSelection(
  deps: Pick<
    BrowserCommandDeps,
    | "authConfigPath"
    | "loadAuthConfig"
    | "saveAuthConfig"
    | "selectedProfileName"
    | "globalsFrom"
  >,
  command: Command,
): BrowserProfileSelection {
  const globals = deps.globalsFrom(command);
  const path = deps.authConfigPath(process.env);
  const config = deps.loadAuthConfig(path);
  const profile = deps.selectedProfileName(globals, config, process.env);
  const profileData = config?.profiles?.[profile];
  const apiScope =
    normalizeApiScope(globals.api) ??
    normalizeApiScope(process.env.COCALC_API_URL) ??
    normalizeApiScope(profileData?.api);
  const browserIdsByApi =
    profileData?.browser_ids_by_api &&
    typeof profileData.browser_ids_by_api === "object" &&
    !Array.isArray(profileData.browser_ids_by_api)
      ? profileData.browser_ids_by_api
      : undefined;
  const browserIdScoped = apiScope
    ? normalizeBrowserId(browserIdsByApi?.[apiScope])
    : undefined;
  const browserIdGlobal = normalizeBrowserId(profileData?.browser_id);
  const browser_id = browserIdScoped ?? browserIdGlobal;
  return {
    path,
    config,
    profile,
    browser_id,
    browser_id_scoped: browserIdScoped,
    browser_id_global: browserIdGlobal,
    api_scope: apiScope,
  };
}

export function saveProfileBrowserId({
  deps,
  command,
  browser_id,
  apiBaseUrl,
}: {
  deps: Pick<
    BrowserCommandDeps,
    | "authConfigPath"
    | "loadAuthConfig"
    | "saveAuthConfig"
    | "selectedProfileName"
    | "globalsFrom"
  >;
  command: Command;
  browser_id?: string;
  apiBaseUrl?: string;
}): { profile: string; browser_id?: string } {
  const { path, config, profile } = loadProfileSelection(deps, command);
  const profileData = { ...(config.profiles?.[profile] ?? {}) };
  const apiScope =
    normalizeApiScope(apiBaseUrl) ??
    normalizeApiScope(process.env.COCALC_API_URL) ??
    normalizeApiScope(profileData.api);

  if (browser_id) {
    profileData.browser_id = browser_id;
  } else {
    delete profileData.browser_id;
  }
  const currentScoped =
    profileData.browser_ids_by_api &&
    typeof profileData.browser_ids_by_api === "object" &&
    !Array.isArray(profileData.browser_ids_by_api)
      ? { ...profileData.browser_ids_by_api }
      : {};
  if (apiScope) {
    if (browser_id) {
      currentScoped[apiScope] = browser_id;
    } else {
      delete currentScoped[apiScope];
    }
  }
  if (Object.keys(currentScoped).length > 0) {
    profileData.browser_ids_by_api = currentScoped;
  } else {
    delete profileData.browser_ids_by_api;
  }

  config.current_profile = profile;
  config.profiles = config.profiles ?? {};
  config.profiles[profile] = profileData;
  deps.saveAuthConfig(config, path);
  return { profile, browser_id };
}

export async function chooseBrowserSession({
  ctx,
  browserHint,
  fallbackBrowserId,
  requireDiscovery = false,
  sessionProjectId,
  activeOnly = false,
}: {
  ctx: BrowserCommandContext;
  browserHint?: string;
  fallbackBrowserId?: string;
  requireDiscovery?: boolean;
  sessionProjectId?: string;
  activeOnly?: boolean;
}): Promise<BrowserSessionInfo> {
  let sessions: BrowserSessionInfo[] | undefined;
  const getSessions = async (): Promise<BrowserSessionInfo[]> => {
    if (sessions) return sessions;
    sessions = (await ctx.hub.system.listBrowserSessions({
      include_stale: !activeOnly,
    })) as BrowserSessionInfo[];
    sessions = (sessions ?? []).filter((s) => (activeOnly ? !s.stale : true));
    sessions = sessions.filter((s) => sessionMatchesProject(s, sessionProjectId));
    return sessions;
  };

  const remapSpawnedSessionByHint = async (
    hint: string,
  ): Promise<BrowserSessionInfo | undefined> => {
    const spawned = resolveSpawnStateByBrowserId(hint);
    if (!spawned) return undefined;
    const marker =
      spawnMarkerFromUrl(spawned.state.target_url) ??
      spawnMarkerFromUrl(spawned.state.session_url);
    if (!marker) return undefined;
    const match = (await getSessions()).find(
      (s) => !s.stale && sessionMatchesSpawnMarker(s, marker),
    );
    if (!match) return undefined;
    if (`${spawned.state.browser_id ?? ""}`.trim() !== `${match.browser_id ?? ""}`.trim()) {
      writeSpawnState(spawned.file, {
        ...spawned.state,
        browser_id: match.browser_id,
        session_url: `${match.url ?? ""}`.trim() || undefined,
        updated_at: nowIso(),
      });
    }
    return match;
  };

  const remapSessionByMarker = async (
    marker: string | undefined,
  ): Promise<BrowserSessionInfo | undefined> => {
    const clean = `${marker ?? ""}`.trim();
    if (!clean) return undefined;
    return (await getSessions()).find(
      (s) => !s.stale && sessionMatchesSpawnMarker(s, clean),
    );
  };

  const explicitHint = normalizeBrowserId(browserHint);
  if (
    explicitHint &&
    !requireDiscovery &&
    isLikelyExactBrowserId(explicitHint) &&
    !activeOnly &&
    !`${sessionProjectId ?? ""}`.trim() &&
    !resolveSpawnStateByBrowserId(explicitHint)
  ) {
    return directBrowserSessionInfo(explicitHint);
  }
  if (explicitHint) {
    try {
      const resolved = resolveBrowserSession(await getSessions(), explicitHint);
      if (!resolved.stale) return resolved;
      const remappedByRowMarker = await remapSessionByMarker(
        spawnMarkerFromUrl(`${resolved.url ?? ""}`),
      );
      if (remappedByRowMarker) return remappedByRowMarker;
      const remapped = await remapSpawnedSessionByHint(explicitHint);
      if (remapped) return remapped;
      throw new Error(`browser session '${explicitHint}' is stale/inactive`);
    } catch (err) {
      const remapped = await remapSpawnedSessionByHint(explicitHint);
      if (remapped) return remapped;
      const msg = `${(err as { message?: string } | undefined)?.message ?? ""}`.trim();
      if (msg) {
        throw err;
      }
      throw new Error(`browser session '${explicitHint}' not found`);
    }
  }
  const savedHint = normalizeBrowserId(fallbackBrowserId);
  if (
    savedHint &&
    !requireDiscovery &&
    !activeOnly &&
    !`${sessionProjectId ?? ""}`.trim() &&
    !resolveSpawnStateByBrowserId(savedHint)
  ) {
    return directBrowserSessionInfo(savedHint);
  }
  const resolvedSessions = await getSessions();
  if (savedHint) {
    try {
      const saved = resolveBrowserSession(resolvedSessions, savedHint);
      if (!saved.stale) {
        return saved;
      }
    } catch {
      const remapped = await remapSpawnedSessionByHint(savedHint);
      if (remapped) return remapped;
    }
  }
  const active = resolvedSessions.filter((s) => !s.stale);
  if (active.length === 1) {
    return active[0];
  }
  if (active.length === 0) {
    if (`${sessionProjectId ?? ""}`.trim()) {
      throw new Error(
        `no active browser sessions found for project '${sessionProjectId}'`,
      );
    }
    throw new Error(
      "no active browser sessions found; open CoCalc in a browser first",
    );
  }
  throw new Error(
    `multiple active browser sessions found (${active.length}); use --browser <id> or 'cocalc browser session use <id>'`,
  );
}
