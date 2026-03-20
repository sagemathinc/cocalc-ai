/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

export interface ParsedPublicViewerImportUrl {
  importUrl: string;
  rawUrl: string;
  path: string;
  title?: string;
}

export function parsePublicViewerImportUrl(
  value: string,
): ParsedPublicViewerImportUrl {
  const importUrl = `${value ?? ""}`.trim();
  if (!importUrl) {
    throw new Error("public import URL is required");
  }
  const parsed = new URL(importUrl);
  const source = parsed.searchParams.get("source")?.trim();
  const queryPath = parsed.searchParams.get("path")?.trim() || undefined;
  const title = parsed.searchParams.get("title")?.trim() || undefined;
  const looksLikeViewerPage = /\/public-viewer(?:-[a-z0-9-]+)?\.html$/i.test(
    parsed.pathname,
  );

  if (looksLikeViewerPage) {
    if (!source) {
      throw new Error("public viewer import URL is missing its source");
    }
    return {
      importUrl: parsed.toString(),
      rawUrl: new URL(source, parsed).toString(),
      path: queryPath || `/${basename(new URL(source, parsed).pathname)}`,
      title,
    };
  }

  return {
    importUrl: parsed.toString(),
    rawUrl: parsed.toString(),
    path: queryPath || parsed.pathname || "/download",
    title,
  };
}
