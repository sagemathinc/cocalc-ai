/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  cocalc_setup_profile,
  frontend_build_fingerprint,
} from "@cocalc/frontend/components/constants";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { joinUrlPath } from "@cocalc/util/url-path";
import {
  isLikelyStaleChunkError,
  onStaleChunkError,
  REFRESH_QUERY_PARAM,
  reloadForFrontendBuild,
  reportStaleChunkError,
  staleChunkErrorSeen,
} from "./stale-chunk";

export {
  isLikelyStaleChunkError,
  reloadForFrontendBuild,
  reportStaleChunkError,
};

const POLL_INTERVAL_MS = 5 * 60_000;
const MIN_CHECK_INTERVAL_MS = 15_000;

export type FrontendBuildManifest = {
  schema: 1;
  git_revision: string;
  build_timestamp: number;
  build_date: string;
  fingerprint: string;
};

export type FrontendBuildStatus = {
  reloadRecommended: boolean;
  current?: FrontendBuildManifest;
  reason?: "build-changed" | "chunk-error";
  // When this tab first learned that it is out of date.
  detectedAt?: number;
};

function usableBuildId(value: unknown): string | undefined {
  const id = `${value ?? ""}`.trim();
  return id && id !== "N/A" ? id : undefined;
}

export function isFrontendBuildMismatch(
  manifest: FrontendBuildManifest,
  localFingerprint = `${frontend_build_fingerprint ?? ""}`,
): boolean {
  const local = usableBuildId(localFingerprint);
  const current = usableBuildId(manifest?.fingerprint);
  return !!local && !!current && local !== current;
}

// CoCalc Star replaces its whole frontend when it is upgraded or downgraded,
// so a tab still running the previous build cannot load the lazy chunks it
// needs. There, a detected build change reloads the tab instead of only
// recommending it. At most once per build, per tab session: if the reloaded
// page still runs a different build (e.g. a cached page), the indicator is
// left to recommend the reload instead, so this can never loop.
export const FORCED_RELOAD_STORAGE_KEY = "cocalc-forced-reload-fingerprint";

export function shouldForceReloadForBuild({
  manifest,
  setupProfile = `${cocalc_setup_profile ?? ""}`,
  localFingerprint = `${frontend_build_fingerprint ?? ""}`,
  alreadyReloadedFor,
}: {
  manifest: FrontendBuildManifest;
  setupProfile?: string;
  localFingerprint?: string;
  alreadyReloadedFor?: string | null;
}): boolean {
  if (setupProfile.trim() !== "star") return false;
  if (!isFrontendBuildMismatch(manifest, localFingerprint)) return false;
  return alreadyReloadedFor !== usableBuildId(manifest.fingerprint);
}

function forceReloadIfRequired(manifest: FrontendBuildManifest): boolean {
  let alreadyReloadedFor: string | null = null;
  try {
    alreadyReloadedFor = window.sessionStorage.getItem(
      FORCED_RELOAD_STORAGE_KEY,
    );
  } catch {
    return false; // no session storage: never risk a reload loop
  }
  if (!shouldForceReloadForBuild({ manifest, alreadyReloadedFor })) {
    return false;
  }
  try {
    window.sessionStorage.setItem(
      FORCED_RELOAD_STORAGE_KEY,
      usableBuildId(manifest.fingerprint) ?? "",
    );
  } catch {
    return false;
  }
  reloadForFrontendBuild(manifest);
  return true;
}

export function urlWithoutFrontendRefreshToken(
  href: string,
): string | undefined {
  const url = new URL(href);
  if (!url.searchParams.has(REFRESH_QUERY_PARAM)) return;
  url.searchParams.delete(REFRESH_QUERY_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

// One monitor per tab, shared by every indicator that shows its status.
let shared: FrontendBuildStatus = { reloadRecommended: false };
const listeners = new Set<(status: FrontendBuildStatus) => void>();
let users = 0;
let stopMonitor: (() => void) | undefined;
let lastCheckAt = 0;

function update(
  next: (previous: FrontendBuildStatus) => FrontendBuildStatus,
): void {
  const previous = shared;
  shared = next(previous);
  if (shared.reloadRecommended && shared.detectedAt == null) {
    shared = { ...shared, detectedAt: Date.now() };
  }
  for (const listener of listeners) listener(shared);
}

// A stale chunk reported anywhere (an error boundary, or the window handlers
// below) recommends a reload in every indicator.
onStaleChunkError(() =>
  update((previous) => ({
    ...previous,
    reloadRecommended: true,
    reason: previous.reason ?? "chunk-error",
  })),
);

function startMonitor(): () => void {
  const cleanUrl = urlWithoutFrontendRefreshToken(window.location.href);
  if (cleanUrl != null) {
    window.history.replaceState(window.history.state, "", cleanUrl);
  }

  let closed = false;
  let inFlight: Promise<void> | undefined;
  const check = async (force = false) => {
    if (closed || typeof window === "undefined") return;
    const now = Date.now();
    if (!force && now - lastCheckAt < MIN_CHECK_INTERVAL_MS) return;
    if (inFlight) return await inFlight;
    lastCheckAt = now;
    const request = (async () => {
      try {
        const path = joinUrlPath(appBasePath, "static/frontend-build.json");
        const response = await fetch(`${path}?_=${now}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) return;
        const manifest = (await response.json()) as FrontendBuildManifest;
        if (closed || manifest?.schema !== 1) return;
        const changed = isFrontendBuildMismatch(manifest);
        if (changed && forceReloadIfRequired(manifest)) return;
        update((previous) => ({
          ...previous,
          current: manifest,
          reloadRecommended:
            previous.reloadRecommended || changed || staleChunkErrorSeen(),
          reason:
            previous.reason ??
            (changed
              ? "build-changed"
              : staleChunkErrorSeen()
                ? "chunk-error"
                : undefined),
        }));
      } catch {
        // Version discovery is advisory and must never disrupt the app.
      }
    })().finally(() => {
      if (inFlight === request) inFlight = undefined;
    });
    inFlight = request;
    await request;
  };
  const onForeground = () => {
    if (document.visibilityState === "visible") void check();
  };
  const onConnected = () => void check();
  const onRuntimeError = (event: unknown) => {
    if (reportStaleChunkError(event)) void check(true);
  };

  const initial = window.setTimeout(
    () => void check(true),
    5_000 + Math.floor(Math.random() * 10_000),
  );
  const interval = window.setInterval(() => void check(), POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", onForeground);
  window.addEventListener("error", onRuntimeError);
  window.addEventListener("unhandledrejection", onRuntimeError);
  webapp_client.on("connected", onConnected);
  return () => {
    closed = true;
    window.clearTimeout(initial);
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onForeground);
    window.removeEventListener("error", onRuntimeError);
    window.removeEventListener("unhandledrejection", onRuntimeError);
    webapp_client.removeListener?.("connected", onConnected);
  };
}

export function useFrontendBuildMonitor(): FrontendBuildStatus {
  const [status, setStatus] = useState<FrontendBuildStatus>(shared);
  useEffect(() => {
    listeners.add(setStatus);
    setStatus(shared);
    if (users++ === 0) stopMonitor = startMonitor();
    return () => {
      listeners.delete(setStatus);
      if (--users === 0) {
        stopMonitor?.();
        stopMonitor = undefined;
      }
    };
  }, []);
  return status;
}
