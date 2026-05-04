/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { slugURL } from "@cocalc/util/news";
import type { NewsItem } from "@cocalc/util/types/news";
import { joinUrlPath } from "@cocalc/util/url-path";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

export function contentNewsPath(news?: Pick<NewsItem, "id" | "title">): string {
  return appPath(slugURL(news));
}

export function newsHistoryPath(permalink: string, timestamp: number): string {
  return `${permalink.replace(/\/$/, "")}/${timestamp}`;
}

export function formatNewsDate(value?: number | Date): string {
  if (value == null) return "";
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(value?: number | Date): string {
  if (value == null) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleString();
}
