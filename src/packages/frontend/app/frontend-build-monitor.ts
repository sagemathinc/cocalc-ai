/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { frontend_build_fingerprint } from "@cocalc/frontend/components/constants";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { joinUrlPath } from "@cocalc/util/url-path";

const POLL_INTERVAL_MS = 5 * 60_000;
const MIN_CHECK_INTERVAL_MS = 15_000;
const REFRESH_QUERY_PARAM = "_cocalc_refresh";

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

export function isLikelyStaleChunkError(value: unknown): boolean {
  const message = `${
    (value as any)?.reason?.message ??
    (value as any)?.error?.message ??
    (value as any)?.message ??
    value ??
    ""
  }`;
  return /ChunkLoadError|Loading (?:CSS )?chunk|__webpack_require__|__webpack_modules__/i.test(
    message,
  );
}

export function reloadForFrontendBuild(manifest?: FrontendBuildManifest): void {
  const url = new URL(window.location.href);
  url.searchParams.set(
    REFRESH_QUERY_PARAM,
    `${manifest?.build_timestamp ?? Date.now()}`,
  );
  window.location.replace(url.toString());
}

export function urlWithoutFrontendRefreshToken(
  href: string,
): string | undefined {
  const url = new URL(href);
  if (!url.searchParams.has(REFRESH_QUERY_PARAM)) return;
  url.searchParams.delete(REFRESH_QUERY_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useFrontendBuildMonitor(): FrontendBuildStatus {
  const [status, setStatus] = useState<FrontendBuildStatus>({
    reloadRecommended: false,
  });
  const lastCheckAt = useRef(0);
  const chunkErrorSeen = useRef(false);

  useEffect(() => {
    const cleanUrl = urlWithoutFrontendRefreshToken(window.location.href);
    if (cleanUrl != null) {
      window.history.replaceState(window.history.state, "", cleanUrl);
    }

    let closed = false;
    let inFlight: Promise<void> | undefined;
    const check = async (force = false) => {
      if (closed || typeof window === "undefined") return;
      const now = Date.now();
      if (!force && now - lastCheckAt.current < MIN_CHECK_INTERVAL_MS) return;
      if (inFlight) return await inFlight;
      lastCheckAt.current = now;
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
          setStatus((previous) => ({
            current: manifest,
            reloadRecommended:
              previous.reloadRecommended || changed || chunkErrorSeen.current,
            reason:
              previous.reason ??
              (changed
                ? "build-changed"
                : chunkErrorSeen.current
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
      if (!isLikelyStaleChunkError(event)) return;
      chunkErrorSeen.current = true;
      setStatus((previous) => ({
        ...previous,
        reloadRecommended: true,
        reason: previous.reason ?? "chunk-error",
      }));
      void check(true);
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
  }, []);

  return status;
}
