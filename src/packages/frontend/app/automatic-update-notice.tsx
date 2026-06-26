/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

declare const DEBUG: boolean;

import { CloseOutlined } from "@ant-design/icons";
import { Button, Popconfirm } from "antd";
import { useEffect, useMemo, useState } from "react";

import {
  build_date,
  smc_git_rev,
  smc_version,
} from "@cocalc/frontend/components/constants";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { Icon } from "@cocalc/frontend/components";
import { joinUrlPath } from "@cocalc/util/url-path";
import { COLORS } from "@cocalc/util/theme";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DISMISSED_KEY_PREFIX = "cocalc-dismissed-static-update";

function isDebugMode(): boolean {
  try {
    return !!DEBUG;
  } catch {
    return false;
  }
}

function storageKey(target: string): string {
  return `${DISMISSED_KEY_PREFIX}:${target}`;
}

function isDismissed(target: string): boolean {
  try {
    return window.localStorage?.getItem(storageKey(target)) === "1";
  } catch {
    return false;
  }
}

function dismiss(target: string): void {
  try {
    window.localStorage?.setItem(storageKey(target), "1");
  } catch {
    // Ignore private browsing / storage failures; dismissal is only a hint.
  }
}

function normalizeScriptUrl(src: string): string {
  try {
    const url = new URL(src, window.location.href);
    url.search = "";
    return url.pathname;
  } catch {
    return src.split("?")[0];
  }
}

function isEntrypointScript(src: string): boolean {
  return /\/static\/(?:load|app)-[^/]+\.js(?:\?|$)/.test(src);
}

function entrypointScriptsFromDocument(doc: Document): string | undefined {
  const scripts = Array.from(doc.scripts)
    .map((script) => script.getAttribute("src") ?? "")
    .filter(isEntrypointScript)
    .map(normalizeScriptUrl)
    .sort();
  return scripts.length > 0 ? scripts.join("|") : undefined;
}

function currentEntrypointScripts(): string | undefined {
  if (typeof document === "undefined") return;
  return entrypointScriptsFromDocument(document);
}

function entrypointScriptsFromHtml(html: string): string | undefined {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return entrypointScriptsFromDocument(doc);
}

async function latestEntrypointScripts(): Promise<string | undefined> {
  const url = joinUrlPath(appBasePath, "static", "app.html");
  const separator = url.includes("?") ? "&" : "?";
  const resp = await fetch(
    `${url}${separator}cocalc-version-check=${Date.now()}`,
    {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    },
  );
  if (!resp.ok) return;
  return entrypointScriptsFromHtml(await resp.text());
}

async function hardRefreshBestEffort(): Promise<void> {
  try {
    if ("caches" in window) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((key) => window.caches.delete(key)));
    }
  } catch {
    // Clearing CacheStorage is best effort; normal reload still works.
  }
  window.location.reload();
}

export default function AutomaticUpdateNotice() {
  const [latestScripts, setLatestScripts] = useState<string>();
  const [closedTarget, setClosedTarget] = useState<string>();

  const currentScripts = useMemo(() => currentEntrypointScripts(), []);

  useEffect(() => {
    if (isDebugMode() || currentScripts == null) return;
    let canceled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function check() {
      try {
        const latest = await latestEntrypointScripts();
        if (canceled || latest == null || latest === currentScripts) return;
        setLatestScripts(latest);
      } catch (err) {
        // A failed version probe must never annoy users or break the app.
        console.debug?.("failed to check for static frontend update", err);
      }
    }

    void check();
    timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      canceled = true;
      if (timer != null) clearInterval(timer);
    };
  }, [currentScripts]);

  if (
    isDebugMode() ||
    latestScripts == null ||
    latestScripts === currentScripts
  ) {
    return null;
  }
  if (closedTarget === latestScripts || isDismissed(latestScripts)) {
    return null;
  }

  const shortVersion =
    smc_git_rev && smc_git_rev !== "N/A"
      ? smc_git_rev.slice(0, 8)
      : `${smc_version}`;

  return (
    <div
      style={{
        position: "fixed",
        right: 14,
        top: 46,
        zIndex: 800,
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "white",
        border: `1px solid ${COLORS.GRAY_L}`,
        borderRadius: 999,
        boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
        padding: "5px 8px 5px 12px",
        color: COLORS.GRAY_D,
        fontSize: 13,
      }}
      title={`Current build ${shortVersion}; built ${build_date}`}
    >
      <Icon name="refresh" style={{ color: COLORS.GRAY }} />
      <span>New version available</span>
      <Popconfirm
        placement="bottomRight"
        title="Refresh CoCalc?"
        description="This reloads the browser tab to use the latest frontend."
        okText="Refresh"
        cancelText="Not now"
        onConfirm={() => void hardRefreshBestEffort()}
      >
        <Button size="small" type="primary">
          Refresh
        </Button>
      </Popconfirm>
      <Button
        size="small"
        type="text"
        aria-label="Dismiss update notice"
        icon={<CloseOutlined />}
        onClick={() => {
          dismiss(latestScripts);
          setClosedTarget(latestScripts);
        }}
      />
    </div>
  );
}
