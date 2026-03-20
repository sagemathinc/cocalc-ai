/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resource_links } from "@cocalc/frontend/misc/resource-links";
import { COLORS } from "@cocalc/util/theme";

export interface PublicViewerConfig {
  path: string;
  rawUrl: string;
  title?: string;
  autoRefreshS?: number;
}

function normalizeAndValidateRawUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl, window.location.origin);
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error("public viewer source must use http or https");
  }
  const currentHost = window.location.hostname;
  const sameHost =
    parsed.hostname === currentHost ||
    parsed.hostname.endsWith(`.${currentHost}`) ||
    parsed.hostname.endsWith(`-${currentHost}`);
  const sameOrigin = parsed.origin === window.location.origin;
  if (!sameOrigin && !sameHost) {
    throw new Error("public viewer source host is not allowed");
  }
  return parsed.toString();
}

export function parseConfig(): PublicViewerConfig {
  const element = document.getElementById("cocalc-public-viewer-config");
  if (element != null) {
    const raw = element.textContent?.trim();
    if (!raw) {
      throw new Error("public viewer config is empty");
    }
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.path !== "string" ||
      typeof parsed?.rawUrl !== "string"
    ) {
      throw new Error("public viewer config is invalid");
    }
    parsed.rawUrl = normalizeAndValidateRawUrl(parsed.rawUrl);
    return parsed;
  }
  const params = new URLSearchParams(window.location.search);
  const rawUrl =
    params.get("source")?.trim() || params.get("rawUrl")?.trim() || "";
  const path = params.get("path")?.trim() || rawUrl || "Untitled";
  const title = params.get("title")?.trim() || undefined;
  const autoRefreshS = Number(params.get("refresh") ?? "");
  if (!rawUrl) {
    throw new Error("public viewer query config is invalid");
  }
  return {
    path,
    rawUrl: normalizeAndValidateRawUrl(rawUrl),
    title,
    autoRefreshS:
      Number.isFinite(autoRefreshS) && autoRefreshS > 0
        ? autoRefreshS
        : undefined,
  };
}

export function ensureViewerStyles(): void {
  const origin = window.location.origin;
  for (const { href } of resource_links(origin)) {
    if (document.querySelector(`link[data-cocalc-public-viewer="${href}"]`)) {
      continue;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-cocalc-public-viewer", href);
    document.head.appendChild(link);
  }
}

function PublicViewerApp({
  config,
  renderContent,
}: {
  config: PublicViewerConfig;
  renderContent: (opts: {
    config: PublicViewerConfig;
    content: string;
  }) => ReactNode;
}): JSX.Element {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    document.title = config.title || config.path;
    setLoading(true);
    setError(undefined);
    setContent(undefined);
    const load = async () => {
      try {
        const response = await fetch(config.rawUrl, {
          credentials: "include",
        });
        if (!response.ok) {
          throw new Error(`Unable to load ${config.path} (${response.status})`);
        }
        const next = await response.text();
        if (cancelled) return;
        setError(undefined);
        setContent(next);
      } catch (err) {
        if (cancelled) return;
        setError(`${err}`);
      } finally {
        if (cancelled) return;
        setLoading(false);
      }
    };
    void load();
    const refreshSeconds = config.autoRefreshS ?? 0;
    const refreshTimer =
      refreshSeconds > 0
        ? window.setInterval(() => {
            void load();
          }, refreshSeconds * 1000)
        : undefined;
    return () => {
      cancelled = true;
      if (refreshTimer != null) {
        window.clearInterval(refreshTimer);
      }
    };
  }, [config]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: COLORS.GRAY_LLL,
        color: COLORS.GRAY_DD,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
          padding: "20px 24px",
          borderBottom: `1px solid ${COLORS.GRAY_L}`,
          background: COLORS.TOP_BAR.ACTIVE,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem" }}>
            {config.title || config.path}
          </h1>
          <div style={{ color: COLORS.GRAY_M, marginTop: "4px" }}>
            Source: <code>{config.path}</code>
          </div>
        </div>
        <a
          href={config.rawUrl}
          rel="noreferrer noopener"
          style={{ color: COLORS.ANTD_LINK_BLUE, fontWeight: 600 }}
        >
          Open raw file
        </a>
      </header>
      <main style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
        {loading ? (
          <div style={{ color: COLORS.GRAY_M }}>Loading document...</div>
        ) : error ? (
          <div
            style={{
              border: `1px solid ${COLORS.BS_RED}`,
              background: COLORS.ANTD_BG_RED_L,
              color: COLORS.BS_RED,
              borderRadius: "8px",
              padding: "16px",
            }}
          >
            {error}
          </div>
        ) : (
          renderContent({ config, content: content ?? "" })
        )}
      </main>
    </div>
  );
}

export function mountPublicViewer(
  renderContent: (opts: {
    config: PublicViewerConfig;
    content: string;
  }) => ReactNode,
): void {
  const container = document.getElementById("cocalc-webapp-container");
  if (container == null) {
    throw new Error("there must be a div with id cocalc-webapp-container");
  }
  ensureViewerStyles();
  const config = parseConfig();
  createRoot(container).render(
    <PublicViewerApp config={config} renderContent={renderContent} />,
  );
}
