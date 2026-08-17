/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { siteUrl } from "./urls";

declare const FRONTEND_BUILD_FINGERPRINT: string;

const CHECK_INTERVAL_MS = 15 * 60_000;

interface FrontendBuildManifest {
  schema: 1;
  fingerprint: string;
}

function bundledFingerprint(): string {
  return typeof FRONTEND_BUILD_FINGERPRINT === "string"
    ? FRONTEND_BUILD_FINGERPRINT
    : "";
}

export function isFrontendUpdate(
  manifest: FrontendBuildManifest,
  localFingerprint: string,
): boolean {
  return (
    manifest?.schema === 1 &&
    !!manifest.fingerprint &&
    !!localFingerprint &&
    manifest.fingerprint !== localFingerprint
  );
}

export function FrontendUpdateNotice({
  localFingerprint = bundledFingerprint(),
  checkIntervalMs = CHECK_INTERVAL_MS,
}: {
  localFingerprint?: string;
  checkIntervalMs?: number;
} = {}) {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!localFingerprint) return;
    const controller = new AbortController();
    let checking = false;
    let updateFound = false;
    let lastCheck = Date.now();
    let timer: number | undefined;

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(check, checkIntervalMs);
    };
    const check = async () => {
      window.clearTimeout(timer);
      if (
        controller.signal.aborted ||
        updateFound ||
        checking ||
        document.visibilityState !== "visible"
      ) {
        if (!controller.signal.aborted && !updateFound) schedule();
        return;
      }
      checking = true;
      lastCheck = Date.now();
      try {
        const response = await fetch(siteUrl("static/frontend-build.json"), {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const manifest = (await response.json()) as FrontendBuildManifest;
        if (isFrontendUpdate(manifest, localFingerprint)) {
          updateFound = true;
          setAvailable(true);
        }
      } catch {
        // This advisory check must never interfere with normal use.
      } finally {
        checking = false;
        if (!controller.signal.aborted && !updateFound) schedule();
      }
    };
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastCheck >= checkIntervalMs
      ) {
        void check();
      }
    };

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkIntervalMs, localFingerprint]);

  if (!available || dismissed) return null;
  return (
    <div aria-live="polite" className="ul-update-tag" role="status">
      <button
        className="ul-update-refresh"
        onClick={() => window.location.reload()}
        type="button"
      >
        Refresh to upgrade
      </button>
      <button
        aria-label="Dismiss frontend update notice"
        className="ul-update-dismiss"
        onClick={() => setDismissed(true)}
        type="button"
      >
        x
      </button>
    </div>
  );
}
