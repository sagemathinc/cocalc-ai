/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { COLORS } from "@cocalc/util/theme";
import PublicViewerFileContents from "./file-contents";

interface PublicViewerConfig {
  path: string;
  rawUrl: string;
  title?: string;
}

function parseConfig(): PublicViewerConfig {
  const element = document.getElementById("cocalc-public-viewer-config");
  if (element == null) {
    throw new Error("public viewer config element not found");
  }
  const raw = element.textContent?.trim();
  if (!raw) {
    throw new Error("public viewer config is empty");
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed?.path !== "string" || typeof parsed?.rawUrl !== "string") {
    throw new Error("public viewer config is invalid");
  }
  return parsed;
}

function PublicViewerApp({
  config,
}: {
  config: PublicViewerConfig;
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
    void fetch(config.rawUrl, { credentials: "omit" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Unable to load ${config.path} (${response.status})`);
        }
        return await response.text();
      })
      .then((next) => {
        if (cancelled) return;
        setContent(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(`${err}`);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [config.path, config.rawUrl, config.title]);

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
          <PublicViewerFileContents
            content={content}
            path={config.path}
            rawUrl={config.rawUrl}
            style={{
              background: COLORS.TOP_BAR.ACTIVE,
              padding: "24px",
              borderRadius: "12px",
              boxShadow: `0 1px 4px ${COLORS.GRAY_L}`,
            }}
          />
        )}
      </main>
    </div>
  );
}

export function init(): void {
  const container = document.getElementById("cocalc-webapp-container");
  if (container == null) {
    throw new Error("there must be a div with id cocalc-webapp-container");
  }
  const config = parseConfig();
  createRoot(container).render(<PublicViewerApp config={config} />);
}
