/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

const STORAGE_KEY = `cocalc-control-plane-origin:${appBasePath}`;

export function normalizeControlPlaneOrigin(
  value: unknown,
): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return;
  try {
    const url = new URL(raw);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function storage(): Storage | undefined {
  if (typeof window === "undefined") return;
  try {
    return window.localStorage;
  } catch {
    return;
  }
}

export function getStoredControlPlaneOrigin(): string | undefined {
  const s = storage();
  if (!s) return;
  return normalizeControlPlaneOrigin(s.getItem(STORAGE_KEY));
}

export function setStoredControlPlaneOrigin(origin: string | undefined): void {
  const s = storage();
  if (!s) return;
  const normalized = normalizeControlPlaneOrigin(origin);
  if (!normalized) {
    s.removeItem(STORAGE_KEY);
    return;
  }
  s.setItem(STORAGE_KEY, normalized);
}

export function clearStoredControlPlaneOrigin(): void {
  const s = storage();
  if (!s) return;
  s.removeItem(STORAGE_KEY);
}

export function getControlPlaneOrigin(): string | undefined {
  if (typeof window === "undefined") {
    return getStoredControlPlaneOrigin();
  }
  return (
    getStoredControlPlaneOrigin() ??
    normalizeControlPlaneOrigin(window.location.origin)
  );
}

export function getControlPlaneAppUrl(): string | undefined {
  const origin = getControlPlaneOrigin();
  if (!origin) return;
  return `${origin}${appBasePath === "/" ? "" : appBasePath}`;
}

function deriveSiteHostname(hostname: string): string {
  const match = hostname.match(/^bay-\d+-(.+)$/);
  return match?.[1] ?? hostname;
}

export function deriveBayControlPlaneOrigin(
  origin: unknown,
  bay_id: unknown,
): string | undefined {
  const normalized = normalizeControlPlaneOrigin(origin);
  const bay = `${bay_id ?? ""}`.trim().toLowerCase();
  if (!normalized || !bay) return;
  try {
    const url = new URL(normalized);
    url.hostname = `${bay}-${deriveSiteHostname(url.hostname)}`;
    return normalizeControlPlaneOrigin(url.toString());
  } catch {
    return;
  }
}
