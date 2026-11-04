/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// React bindings for the account catalog: each hook does work only while its
// consumer is enabled (visible), and refreshes a stale part when the browser
// tab becomes visible again. There are no timers.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { sharedArtifactCatalog } from "./artifact-catalog-store";
import {
  sharedAccountCatalog,
  type AccountArtifactCatalog,
  type CatalogListSession,
  type CatalogReadMode,
} from "./account-catalog";

const NEVER = (_listener: () => void) => () => {};

export function accountCatalogFor(accountId: string): AccountArtifactCatalog {
  return sharedAccountCatalog(
    accountId,
    () => webapp_client.conat_client?.hub?.artifactCatalog as any,
  );
}

/**
 * Which catalog reads to use. Nothing is asked until `enabled`; a disabled
 * consumer still sees the answer once another one has asked. Until it is
 * known the mode is "pending" and no catalog work starts.
 */
export function useCatalogReadMode(
  accountId: string | undefined,
  enabled: boolean,
): CatalogReadMode | "pending" {
  const catalog = accountId ? accountCatalogFor(accountId) : undefined;
  const known = useSyncExternalStore(
    catalog ? (listener) => catalog.onMode(listener) : NEVER,
    () => catalog?.knownMode,
  );
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!catalog || !enabled || known) return;
    let cancelled = false;
    void catalog.readMode().then((value) => {
      if (!cancelled) setUnavailable(value === "unavailable");
    });
    return () => {
      cancelled = true;
    };
  }, [catalog, enabled, known, attempt]);
  // A failure to tell is asked again when the tab is shown again.
  useEffect(() => {
    if (!unavailable || !enabled || known) return;
    const onVisible = () => {
      if (document.visibilityState !== "hidden") setAttempt((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [unavailable, enabled, known]);
  return known ?? (unavailable ? "unavailable" : "pending");
}

/** The older hubs' per-project catalog, for legacy mode. */
export function legacyCatalogFor(accountId: string) {
  return sharedArtifactCatalog(accountId, (opts) =>
    webapp_client.conat_client.hub.artifactCatalog.listProject(opts),
  );
}

/**
 * Holds the older hubs' catalog while `hold` is true (a visible consumer in
 * legacy mode), over the named agents' projects. Any visible consumer can
 * start it, with or without the Library page mounted.
 */
export function useLegacyCatalogHold(
  accountId: string | undefined,
  agents: NamedAgent[],
  hold: boolean,
) {
  const key = JSON.stringify(
    [...new Set(agents.map((agent) => agent.endpoint.project_id))].sort(),
  );
  useEffect(() => {
    if (!accountId || !hold) return;
    return legacyCatalogFor(accountId).acquire(JSON.parse(key));
  }, [accountId, key, hold]);
}

/** Calls `ensure` when the tab becomes visible again (stale parts reload). */
function useOnVisible(enabled: boolean, ensure: () => void) {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState !== "hidden") ensure();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, ensure]);
}

/** A list session's state, driven while enabled. */
export function useCatalogList(
  session: CatalogListSession | undefined,
  enabled: boolean,
  request: { query?: string; project_id?: string } = {},
  readable?: (project_id: string) => boolean,
) {
  const raw = useSyncExternalStore(
    session?.subscribe ?? NEVER,
    session?.get ?? emptyGet,
  );
  const { query, project_id } = request;
  const lastQuery = useRef(query);
  useEffect(() => {
    if (!session || !enabled) return;
    // Typing waits for a pause; other changes load at once.
    session.set({ query, project_id }, query !== lastQuery.current);
    lastQuery.current = query;
  }, [session, enabled, query, project_id]);
  const ensure = useCallback(() => session?.ensure(), [session]);
  useOnVisible(!!session && enabled, ensure);
  // The server authorizes every row; this also drops rows of a project the
  // browser has just seen become unreadable, as for pins.
  return useMemo(
    () =>
      readable
        ? {
            ...raw,
            entries: raw.entries.filter((entry) => readable(entry.project_id)),
          }
        : raw,
    [raw, readable],
  );
}

const EMPTY_LIST = { entries: [], loading: false, loaded: false };
const emptyGet = () => EMPTY_LIST as any;

const READ_GROUPS = new Set(["owner", "collaborator"]);

/** The browser's view of which projects the account may read (owner or
 * collaborator, not deleted); undefined until the project list is loaded. */
export function useReadableProjects(
  accountId: string | undefined,
): ((project_id: string) => boolean) | undefined {
  const projectMap = useTypedRedux("projects", "project_map");
  return useMemo(() => {
    if (!accountId || projectMap == null) return undefined;
    return (project_id: string) => {
      const project = projectMap.get(project_id);
      if (!project || project.get("deleted")) return false;
      return READ_GROUPS.has(
        project.getIn(["users", accountId, "group"]) as string,
      );
    };
  }, [accountId, projectMap]);
}

/** Pinned entries, driven while enabled. */
export function usePinnedEntries(
  catalog: AccountArtifactCatalog | undefined,
  enabled: boolean,
  pinKeys: string[],
  readable: ((project_id: string) => boolean) | undefined,
) {
  const pins = catalog?.pins;
  const state = useSyncExternalStore(
    pins?.subscribe ?? NEVER,
    pins?.get ?? emptyPins,
  );
  const keys = JSON.stringify(pinKeys);
  useEffect(() => {
    if (!pins || !enabled || !readable) return;
    pins.set(JSON.parse(keys), readable);
  }, [pins, enabled, keys, readable]);
  const ensure = useCallback(() => {
    if (pins && readable) pins.set(JSON.parse(keys), readable);
  }, [pins, keys, readable]);
  useOnVisible(!!pins && enabled, ensure);
  return state;
}

const EMPTY_PINS = { pins: new Map(), loading: false };
const emptyPins = () => EMPTY_PINS as any;
