/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { FrontendSourceFingerprintInfo } from "@cocalc/conat/hub/api/system";
import {
  build_date,
  frontend_build_available,
  frontend_build_fingerprint,
  frontend_build_latest_mtime_iso,
  frontend_build_latest_mtime_ms,
  frontend_build_latest_path,
  frontend_build_watched_roots,
  smc_git_rev,
} from "@cocalc/frontend/components/constants";
import { COLORS } from "@cocalc/util/theme";

declare const DEBUG: boolean;

declare global {
  interface Window {
    cc: any;
  }
}

const POLL_MS = 15_000;
const BANNER_ID = "cocalc-debug-build-warning";

type DebugClient = {
  conat_client?: {
    hub?: {
      system?: {
        getFrontendSourceFingerprint?: () => Promise<FrontendSourceFingerprintInfo>;
      };
    };
  };
  on?: (event: string, listener: () => void) => void;
  off?: (event: string, listener: () => void) => void;
};

export interface FrontendBuildCheckStatus {
  checked_at: string;
  build: FrontendSourceFingerprintInfo;
  source?: FrontendSourceFingerprintInfo;
  mismatch: boolean;
  summary: string;
  error?: string;
}

let started = false;
let lastStatus: FrontendBuildCheckStatus | undefined;
let activeClient: DebugClient | undefined;
let dismissedMismatchSignature: string | undefined;
let pollTimer: number | undefined;
let stopChecks: (() => void) | undefined;

function shortRevision(rev: string): string {
  return rev.length > 12 ? rev.slice(0, 12) : rev;
}

export function createMismatchSignature(
  build: FrontendSourceFingerprintInfo,
  source: FrontendSourceFingerprintInfo,
): string {
  return `${build.fingerprint}::${source.fingerprint}`;
}

function getBuiltFrontendFingerprint(): FrontendSourceFingerprintInfo {
  return {
    available: !!frontend_build_available,
    fingerprint: `${frontend_build_fingerprint ?? "N/A"}`,
    git_revision: `${smc_git_rev ?? "N/A"}`,
    latest_mtime_ms:
      typeof frontend_build_latest_mtime_ms === "number" &&
      frontend_build_latest_mtime_ms > 0
        ? frontend_build_latest_mtime_ms
        : null,
    latest_mtime_iso:
      frontend_build_latest_mtime_iso &&
      frontend_build_latest_mtime_iso !== "N/A"
        ? frontend_build_latest_mtime_iso
        : undefined,
    latest_path:
      frontend_build_latest_path && frontend_build_latest_path !== "N/A"
        ? frontend_build_latest_path
        : undefined,
    watched_roots: Array.isArray(frontend_build_watched_roots)
      ? frontend_build_watched_roots
      : [],
    scanned_file_count: 0,
    checked_at: `${build_date ?? "N/A"}`,
    reason: frontend_build_available
      ? undefined
      : "bundle fingerprint unavailable",
  };
}

export function describeFrontendFingerprintMismatch(
  build: FrontendSourceFingerprintInfo,
  source: FrontendSourceFingerprintInfo,
): string {
  if (!build.available) {
    return "This bundle does not include a usable frontend fingerprint.";
  }
  if (!source.available) {
    return `Current source fingerprint unavailable: ${source.reason ?? "unknown reason"}.`;
  }
  if (build.fingerprint === source.fingerprint) {
    return "Frontend build fingerprint matches the current repo tree.";
  }
  if (build.git_revision !== source.git_revision) {
    return `The repo HEAD changed from ${shortRevision(build.git_revision)} to ${shortRevision(source.git_revision)} after this tab loaded.`;
  }
  return "Repository files changed on disk after this tab loaded.";
}

function setBannerVisible(visible: boolean): HTMLDivElement | undefined {
  let banner = document.getElementById(BANNER_ID) as HTMLDivElement | null;
  if (banner == null && visible) {
    banner = document.createElement("div");
    banner.id = BANNER_ID;
    Object.assign(banner.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      width: "min(560px, calc(100vw - 32px))",
      maxHeight: "45vh",
      overflow: "auto",
      zIndex: "10001",
      padding: "14px 16px",
      borderRadius: "8px",
      border: `2px solid ${COLORS.ANTD_RED_WARN}`,
      background: COLORS.ANTD_BG_RED_L,
      color: COLORS.GRAY_DD,
      boxShadow: "0 8px 30px rgba(0, 0, 0, 0.18)",
      fontFamily:
        "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      fontSize: "12px",
      lineHeight: "1.45",
      whiteSpace: "pre-wrap",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(banner);
  }
  if (banner != null) {
    banner.style.display = visible ? "block" : "none";
  }
  return banner ?? undefined;
}

export function renderBanner(status: FrontendBuildCheckStatus): void {
  const banner = setBannerVisible(status.mismatch);
  if (banner == null || !status.mismatch || status.source == null) {
    return;
  }
  const signature = createMismatchSignature(status.build, status.source);
  if (dismissedMismatchSignature === signature) {
    hideBanner();
    return;
  }
  const build = status.build;
  const source = status.source;
  const lines = [
    status.summary,
    "",
    `Built bundle: ${shortRevision(build.git_revision)}  ${build.latest_mtime_iso ?? "N/A"}  ${build.latest_path ?? "N/A"}`,
    `Current disk:  ${shortRevision(source.git_revision)}  ${source.latest_mtime_iso ?? "N/A"}  ${source.latest_path ?? "N/A"}`,
    "",
    "If you just rebuilt or restarted services, reload this tab.",
    "If you changed code without rebuilding or restarting the affected service, do that first and then reload.",
  ];
  banner.replaceChildren();

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    marginBottom: "8px",
  } satisfies Partial<CSSStyleDeclaration>);

  const title = document.createElement("div");
  title.textContent = "Stale Frontend Build Detected";
  Object.assign(title.style, {
    fontWeight: "700",
    fontSize: "13px",
  } satisfies Partial<CSSStyleDeclaration>);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.setAttribute("aria-label", "Dismiss stale frontend build warning");
  Object.assign(dismiss.style, {
    border: `1px solid ${COLORS.ANTD_RED_WARN}`,
    background: "white",
    color: COLORS.GRAY_DD,
    borderRadius: "6px",
    padding: "4px 8px",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "12px",
  } satisfies Partial<CSSStyleDeclaration>);
  dismiss.onclick = () => {
    dismissedMismatchSignature = signature;
    hideBanner();
  };

  const body = document.createElement("pre");
  body.textContent = lines.join("\n");
  Object.assign(body.style, {
    margin: "0",
    whiteSpace: "pre-wrap",
    fontFamily: "inherit",
  } satisfies Partial<CSSStyleDeclaration>);

  header.append(title, dismiss);
  banner.append(header, body);
}

export function hideBanner(): void {
  setBannerVisible(false);
}

export function resetDebugBuildCheckBannerState(): void {
  dismissedMismatchSignature = undefined;
  const banner = document.getElementById(BANNER_ID);
  banner?.remove();
}

export function resetDebugBuildCheckStateForTests(): void {
  stopChecks?.();
  stopChecks = undefined;
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
  started = false;
  lastStatus = undefined;
  activeClient = undefined;
  resetDebugBuildCheckBannerState();
}

function updateDebugNamespace(): void {
  if (window.cc == null) {
    return;
  }
  window.cc.frontend_build_check = {
    poll_ms: POLL_MS,
    built: getBuiltFrontendFingerprint(),
    last: lastStatus,
    getLastStatus() {
      return lastStatus;
    },
    async checkNow() {
      if (activeClient == null) {
        return lastStatus;
      }
      return await checkFrontendBuildFingerprint(activeClient);
    },
  };
}

export async function checkFrontendBuildFingerprint(
  client: DebugClient,
): Promise<FrontendBuildCheckStatus> {
  activeClient = client;
  const build = getBuiltFrontendFingerprint();
  const getSource =
    client.conat_client?.hub?.system?.getFrontendSourceFingerprint;
  if (typeof getSource !== "function") {
    lastStatus = {
      checked_at: new Date().toISOString(),
      build,
      mismatch: false,
      summary: "frontend source fingerprint API unavailable",
      error: "frontend source fingerprint API unavailable",
    };
    hideBanner();
    updateDebugNamespace();
    return lastStatus;
  }

  try {
    const source = await getSource();
    const mismatch =
      build.available &&
      source.available &&
      build.fingerprint !== source.fingerprint;
    lastStatus = {
      checked_at: new Date().toISOString(),
      build,
      source,
      mismatch,
      summary: describeFrontendFingerprintMismatch(build, source),
    };
  } catch (err) {
    lastStatus = {
      checked_at: new Date().toISOString(),
      build,
      mismatch: false,
      summary: "unable to check frontend source fingerprint",
      error: `${err}`,
    };
  }

  if (lastStatus.mismatch) {
    renderBanner(lastStatus);
  } else {
    dismissedMismatchSignature = undefined;
    hideBanner();
  }
  updateDebugNamespace();
  return lastStatus;
}

export function initDebugBuildCheck(client: DebugClient): void {
  if (!DEBUG || typeof window === "undefined" || window.cc == null) {
    return;
  }
  activeClient = client;
  updateDebugNamespace();
  if (started) {
    return;
  }
  started = true;
  const runCheck = () => {
    if (document.visibilityState === "hidden") {
      return;
    }
    void checkFrontendBuildFingerprint(activeClient ?? client);
  };
  const onFocus = () => runCheck();
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      runCheck();
    }
  };
  const onConnected = () => runCheck();
  runCheck();
  pollTimer = window.setInterval(runCheck, POLL_MS);
  window.addEventListener("focus", onFocus);
  window.addEventListener("visibilitychange", onVisibilityChange);
  client.on?.("connected", onConnected);
  stopChecks = () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("visibilitychange", onVisibilityChange);
    client.off?.("connected", onConnected);
  };
}
