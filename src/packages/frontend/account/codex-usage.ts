/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CodexUsageStatusInfo } from "@cocalc/conat/hub/api/system";
import { lite } from "@cocalc/frontend/lite";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";

export const CODEX_USAGE_LABEL = "Open ChatGPT Codex Usage";

export const CODEX_USAGE_STATUS_TIMEOUT_MS = 60_000;
const CODEX_USAGE_STATUS_CACHE_PREFIX = "cocalc.chat.codexUsageStatusCache.v2";

export interface CachedCodexUsageStatus {
  status: CodexUsageStatusInfo;
  cachedAt: number;
}

export type CodexSubscriptionConnection = {
  status: "connected" | "needs-sign-in" | "unverified";
  reason?: string;
};

function isCodexUsageAuthenticationProblem(
  status?: CodexUsageStatusInfo,
): boolean {
  const text = [
    status?.reason,
    status?.errors?.account,
    status?.errors?.rateLimits,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return (
    text.includes("auth") ||
    text.includes("credential") ||
    text.includes("expired") ||
    text.includes("incomplete") ||
    text.includes("sign in") ||
    text.includes("sign-in") ||
    text.includes("token")
  );
}

export function getCodexSubscriptionConnection(
  status?: CodexUsageStatusInfo,
): CodexSubscriptionConnection {
  if (status?.authentication) return status.authentication;
  if (isCodexUsageAuthenticationProblem(status)) {
    return {
      status: "needs-sign-in",
      reason:
        "ChatGPT could not authenticate the stored sign-in. Sign in again with ChatGPT in CoCalc, then retry.",
    };
  }
  if (status?.available || getChatGptAccountInfo(status)) {
    return { status: "connected" };
  }
  return {
    status: "unverified",
    reason: status?.reason ?? "CoCalc could not verify the ChatGPT sign-in.",
  };
}

function getCodexUsageStatusCacheKey(accountId?: string): string {
  return `${CODEX_USAGE_STATUS_CACHE_PREFIX}:${encodeURIComponent(
    accountId || "account",
  )}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function isCachedCodexUsageStatus(
  value: unknown,
): value is CodexUsageStatusInfo {
  return (
    isObject(value) &&
    typeof value.available === "boolean" &&
    typeof value.checkedAt === "string" &&
    isObject(value.paymentSource)
  );
}

function getCodexRateLimit(status?: CodexUsageStatusInfo): any {
  const rateLimits = status?.rateLimits as any;
  return (
    rateLimits?.rateLimitsByLimitId?.codex ??
    rateLimits?.rate_limits_by_limit_id?.codex ??
    rateLimits?.rateLimits ??
    rateLimits?.rate_limits
  );
}

export function getChatGptAccountInfo(
  status?: CodexUsageStatusInfo,
): { email?: string; planType?: string } | undefined {
  const account = (status?.account as any)?.account;
  if (account?.type !== "chatgpt") return undefined;
  return {
    email: typeof account.email === "string" ? account.email : undefined,
    planType:
      typeof account.planType === "string"
        ? account.planType
        : typeof account.plan_type === "string"
          ? account.plan_type
          : undefined,
  };
}

export function hasCodexUsageRateLimitWindows(
  status?: CodexUsageStatusInfo,
): boolean {
  const rateLimit = getCodexRateLimit(status);
  return isObject(rateLimit?.primary) || isObject(rateLimit?.secondary);
}

export function readCachedCodexUsageStatus({
  accountId,
}: {
  accountId?: string;
}): CachedCodexUsageStatus | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(
      getCodexUsageStatusCacheKey(accountId),
    );
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) return undefined;
    if (parsed.version !== 1) return undefined;
    if (typeof parsed.cachedAt !== "number") return undefined;
    if (!isCachedCodexUsageStatus(parsed.status)) return undefined;
    return {
      cachedAt: parsed.cachedAt,
      status: parsed.status,
    };
  } catch {
    return undefined;
  }
}

export function writeCachedCodexUsageStatus({
  accountId,
  status,
}: {
  accountId?: string;
  status: CodexUsageStatusInfo;
}): void {
  if (!hasCodexUsageRateLimitWindows(status)) return;
  try {
    globalThis.localStorage?.setItem(
      getCodexUsageStatusCacheKey(accountId),
      JSON.stringify({
        version: 1,
        cachedAt: Date.now(),
        status,
      }),
    );
  } catch {
    // Ignore storage errors; this cache only avoids a temporary UI jump.
  }
}

export async function getLiveCodexUsageStatus({
  projectId,
  includeModels = false,
}: {
  projectId?: string;
  includeModels?: boolean;
}): Promise<CodexUsageStatusInfo> {
  if (projectId && !lite) {
    return await webapp_client.conat_client.hub.projects.getCodexUsageStatus({
      project_id: projectId,
      include_models: includeModels,
      timeout: CODEX_USAGE_STATUS_TIMEOUT_MS,
    });
  }
  return await webapp_client.conat_client.hub.system.getCodexUsageStatus({
    project_id: projectId || undefined,
    include_models: includeModels,
    timeout: CODEX_USAGE_STATUS_TIMEOUT_MS,
  });
}
