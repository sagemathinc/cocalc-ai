/*
 *  This file is part of CoCalc: Copyright (C) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOrigin } from "@cocalc/server/bay-public-origin";
import adminAlert from "@cocalc/server/messages/admin-alert";

const logger = getLogger("server:monitoring:frontend-assets");
const DEFAULT_INTERVAL_MS = 60 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_HISTORY_ATTEMPTS = 3;
const DEFAULT_HISTORY_RETRY_DELAY_MS = 1_000;
const MAX_ASSETS = 10_000;
const CONCURRENCY = 20;

type AssetHistory = {
  schema?: unknown;
  builds?: { assets?: unknown }[];
};

export type FrontendAssetProbeResult = {
  origin: string;
  builds: number;
  assets: number;
  failures: string[];
};

export function parseFrontendAssetHistory(value: unknown): {
  builds: number;
  assets: string[];
} {
  const history = value as AssetHistory;
  if (history?.schema !== 1 || !Array.isArray(history.builds)) {
    throw new Error("frontend asset history has an unsupported schema");
  }
  if (history.builds.length < 1 || history.builds.length > 2) {
    throw new Error("frontend asset history must contain one or two builds");
  }
  const assets = new Set<string>();
  for (const build of history.builds) {
    if (!Array.isArray(build?.assets) || build.assets.length === 0) {
      throw new Error("frontend asset history contains an empty build");
    }
    for (const value of build.assets) {
      const asset = `${value ?? ""}`.replace(/\\/g, "/");
      const basename = asset.slice(asset.lastIndexOf("/") + 1);
      if (
        !asset ||
        asset.startsWith("/") ||
        asset.split("/").includes("..") ||
        !/(?:^|[-.])[0-9a-f]{16,}(?=[-.]|$)/i.test(basename)
      ) {
        throw new Error(
          `frontend asset history contains unsafe path: ${asset}`,
        );
      }
      assets.add(asset);
      if (assets.size > MAX_ASSETS) {
        throw new Error(`frontend asset history exceeds ${MAX_ASSETS} files`);
      }
    }
  }
  return { builds: history.builds.length, assets: [...assets] };
}

async function fetchWithTimeout({
  fetchImpl,
  url,
  method,
  timeoutMs,
}: {
  fetchImpl: typeof fetch;
  url: string;
  method: "GET" | "HEAD";
  timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function probeFrontendAssets({
  origin,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  historyAttempts = DEFAULT_HISTORY_ATTEMPTS,
  historyRetryDelayMs = DEFAULT_HISTORY_RETRY_DELAY_MS,
}: {
  origin: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  historyAttempts?: number;
  historyRetryDelayMs?: number;
}): Promise<FrontendAssetProbeResult> {
  const attempts = Math.max(1, Math.floor(historyAttempts));
  let historyResponse: Response | undefined;
  let historyError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const historyUrl = new URL(
      "static/frontend-build-history.json",
      `${origin}/`,
    );
    historyUrl.searchParams.set("_", `${Date.now()}-${attempt}`);
    try {
      historyResponse = await fetchWithTimeout({
        fetchImpl,
        url: historyUrl.toString(),
        method: "GET",
        timeoutMs,
      });
      historyError = undefined;
      if (historyResponse.ok) break;
    } catch (err) {
      historyResponse = undefined;
      historyError = err;
    }
    if (attempt + 1 < attempts) {
      await delay(historyRetryDelayMs);
    }
  }
  if (historyResponse == null) {
    throw historyError instanceof Error
      ? historyError
      : new Error(`frontend asset history request failed: ${historyError}`);
  }
  if (!historyResponse.ok) {
    throw new Error(
      `frontend asset history returned HTTP ${historyResponse.status}`,
    );
  }
  const { builds, assets } = parseFrontendAssetHistory(
    await historyResponse.json(),
  );
  const failures: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, assets.length) }, async () => {
      while (next < assets.length) {
        const asset = assets[next++];
        const url = new URL(`static/${asset}`, `${origin}/`).toString();
        let detail = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await fetchWithTimeout({
              fetchImpl,
              url,
              method: "HEAD",
              timeoutMs,
            });
            if (response.ok) {
              detail = "";
              break;
            }
            detail = `HTTP ${response.status}`;
          } catch (err) {
            detail = err instanceof Error ? err.message : `${err}`;
          }
        }
        if (detail) failures.push(`${asset}: ${detail}`);
      }
    }),
  );
  return { origin, builds, assets: assets.length, failures };
}

let maintenanceStarted = false;

export function frontendAssetMonitoringEnabled({
  configured = process.env.COCALC_FRONTEND_ASSET_MONITORING,
  nodeEnv = process.env.NODE_ENV,
}: {
  configured?: string;
  nodeEnv?: string;
} = {}): boolean {
  const value = `${configured ?? ""}`.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  // Dev upgrades do not create the retained-release history manifest. Keep
  // their missing manifest from paging admins. Packaged bay workers currently
  // leave NODE_ENV unset, so unknown/unset environments retain monitoring.
  return !["development", "test"].includes(
    `${nodeEnv ?? ""}`.trim().toLowerCase(),
  );
}

export async function runFrontendAssetHealthCheck(): Promise<
  FrontendAssetProbeResult | undefined
> {
  const origin = await getBayPublicOrigin(getConfiguredBayId());
  if (!origin) {
    logger.debug("frontend asset health check skipped without a public origin");
    return;
  }
  const result = await probeFrontendAssets({ origin });
  if (result.failures.length) {
    await adminAlert({
      subject: `Frontend static assets unavailable on ${new URL(origin).host}`,
      body: [
        `${result.failures.length} of ${result.assets} current/previous content-addressed frontend assets failed public HEAD probes.`,
        `origin=${origin}`,
        `builds=${result.builds}`,
        "",
        ...result.failures.slice(0, 20),
      ].join("\n"),
      dedupMinutes: 60,
      dedupBySubject: true,
    });
  }
  return result;
}

export function startFrontendAssetHealthMaintenance({
  intervalMs = DEFAULT_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
}: {
  intervalMs?: number;
  initialDelayMs?: number;
} = {}): void {
  if (maintenanceStarted) return;
  if (!frontendAssetMonitoringEnabled()) {
    logger.info("frontend asset health maintenance disabled", {
      node_env: process.env.NODE_ENV,
      configured: process.env.COCALC_FRONTEND_ASSET_MONITORING,
    });
    return;
  }
  maintenanceStarted = true;
  const run = async () => {
    try {
      const result = await runFrontendAssetHealthCheck();
      if (result) {
        logger.info("frontend asset health check completed", result);
      }
    } catch (err) {
      logger.warn("frontend asset health check failed", { err: `${err}` });
      await adminAlert({
        subject: "Frontend static asset monitoring failed",
        body: `${err}`,
        dedupMinutes: 60,
        dedupBySubject: true,
      });
    }
  };
  const initial = setTimeout(() => void run(), initialDelayMs);
  initial.unref?.();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  logger.info("frontend asset health maintenance started", {
    interval_ms: intervalMs,
    initial_delay_ms: initialDelayMs,
  });
}
