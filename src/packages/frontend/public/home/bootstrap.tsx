/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createRoot } from "react-dom/client";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import type { NewsItem } from "@cocalc/util/types/news";
import PublicHomeApp from "./app";

interface CustomizePayload {
  configuration?: {
    help_email?: string;
    is_authenticated?: boolean;
    organization_name?: string;
    organization_url?: string;
    policy_pages?: string;
    show_policies?: boolean;
    site_description?: string;
    site_name?: string;
  };
}

const CUSTOMIZE_RETRY_START_DELAY_MS = 500;
const CUSTOMIZE_RETRY_MAX_DELAY_MS = 5000;

async function fetchJsonWithTimeout<T>(
  path: string,
  timeoutMs: number,
): Promise<T | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(joinUrlPath(appBasePath, path), {
      signal: controller.signal,
    });
    return (await resp.json()) as T;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCustomize(): Promise<CustomizePayload | undefined> {
  let retryDelayMs = CUSTOMIZE_RETRY_START_DELAY_MS;
  while (true) {
    const payload = await fetchJsonWithTimeout<CustomizePayload>(
      "customize",
      3000,
    );
    if (payload != null) {
      return payload;
    }
    await delay(retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, CUSTOMIZE_RETRY_MAX_DELAY_MS);
  }
}

async function loadNews(): Promise<NewsItem[] | undefined> {
  const payload = await fetchJsonWithTimeout<unknown>("api/v2/news/list", 1000);
  return Array.isArray(payload) ? (payload as NewsItem[]) : undefined;
}

export async function init(): Promise<void> {
  const [customize, news] = await Promise.all([loadCustomize(), loadNews()]);
  const root = createRoot(document.getElementById("cocalc-webapp-container")!);
  root.render(
    <PublicHomeApp config={customize?.configuration} initialNews={news} />,
  );
}
