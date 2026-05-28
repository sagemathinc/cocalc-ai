/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { set_url_with_search } from "@cocalc/frontend/history";

export const HOST_DRAWER_OPEN_EVENT = "cocalc:hosts:open-drawer";
const HOST_DRAWER_OPEN_STORAGE_KEY = "cocalc:hosts:open-drawer-request";

export type HostDrawerOpenDetail = {
  hostId: string;
  tab?: string;
};

function normalizeHostDrawerOpenDetail(
  detail: HostDrawerOpenDetail,
): HostDrawerOpenDetail | undefined {
  const hostId = `${detail.hostId ?? ""}`.trim();
  const tab = `${detail.tab ?? ""}`.trim();
  if (!hostId) return undefined;
  return { hostId, tab: tab || undefined };
}

export function storeHostDrawerOpenRequest(
  detail: HostDrawerOpenDetail,
): HostDrawerOpenDetail | undefined {
  if (typeof window === "undefined") return undefined;
  const normalized = normalizeHostDrawerOpenDetail(detail);
  if (!normalized) return undefined;
  window.sessionStorage.setItem(
    HOST_DRAWER_OPEN_STORAGE_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}

export function readStoredHostDrawerOpenRequest():
  | HostDrawerOpenDetail
  | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.sessionStorage.getItem(HOST_DRAWER_OPEN_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as HostDrawerOpenDetail;
    return normalizeHostDrawerOpenDetail(parsed);
  } catch {
    clearStoredHostDrawerOpenRequest();
    return undefined;
  }
}

export function clearStoredHostDrawerOpenRequest(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(HOST_DRAWER_OPEN_STORAGE_KEY);
}

export function openHostDrawer(
  detail: HostDrawerOpenDetail,
): HostDrawerOpenDetail | undefined {
  const normalized = storeHostDrawerOpenRequest(detail);
  if (!normalized) return undefined;
  const pageActions = redux.getActions("page") as
    | {
        set_active_tab?: (
          key: string,
          changeHistory?: boolean,
        ) => Promise<void>;
      }
    | undefined;
  void pageActions?.set_active_tab?.("hosts", false);
  if (typeof window !== "undefined") {
    set_url_with_search("/hosts", "");
    window.dispatchEvent(
      new CustomEvent<HostDrawerOpenDetail>(HOST_DRAWER_OPEN_EVENT, {
        detail: normalized,
      }),
    );
  }
  return normalized;
}
