/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import centralLog from "@cocalc/database/postgres/central-log";
import type { HubApiPrincipalPolicy } from "@cocalc/conat/hub/api/util";

const logger = getLogger("server:conat:api:principal-policy-denials");
const DEFAULT_RECORD_INTERVAL_MS = 60_000;
const MAX_RATE_LIMIT_KEYS = 10_000;
const lastRecorded = new Map<string, number>();

export type HubApiPrincipalType = "account" | "project" | "host" | "agent";

export interface HubApiPrincipalDenial {
  principal_type: HubApiPrincipalType;
  account_id?: string;
  project_id?: string;
  host_id?: string;
  method: string;
  required_policy: HubApiPrincipalPolicy;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength
    ? normalized.slice(0, maxLength)
    : normalized;
}

export function normalizeHubApiPrincipalDenial(
  denial: HubApiPrincipalDenial,
): HubApiPrincipalDenial {
  return {
    principal_type: denial.principal_type,
    account_id: optionalString(denial.account_id, 80),
    project_id: optionalString(denial.project_id, 80),
    host_id: optionalString(denial.host_id, 80),
    method: optionalString(denial.method, 256) ?? "unknown",
    required_policy: denial.required_policy,
  };
}

function recordIntervalMs(): number {
  const configured = Number(
    process.env.COCALC_HUB_API_PRINCIPAL_DENIAL_INTERVAL_MS,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_RECORD_INTERVAL_MS;
  }
  return Math.max(1_000, Math.floor(configured));
}

function rateLimitKey(denial: HubApiPrincipalDenial): string {
  return [
    denial.principal_type,
    denial.account_id,
    denial.project_id,
    denial.host_id,
    denial.method,
    denial.required_policy,
  ]
    .map((value) => `${value ?? ""}`)
    .join("\n");
}

function makeRateLimitSpace(now: number): void {
  if (lastRecorded.size < MAX_RATE_LIMIT_KEYS) return;
  const cutoff = now - recordIntervalMs();
  for (const [key, recordedAt] of lastRecorded) {
    if (recordedAt <= cutoff) lastRecorded.delete(key);
    if (lastRecorded.size < MAX_RATE_LIMIT_KEYS) return;
  }
  const oldestKey = lastRecorded.keys().next().value;
  if (oldestKey != null) lastRecorded.delete(oldestKey);
}

export async function recordHubApiPrincipalDenial(
  input: HubApiPrincipalDenial,
  now = Date.now(),
): Promise<boolean> {
  const denial = normalizeHubApiPrincipalDenial(input);
  const key = rateLimitKey(denial);
  const recordedAt = lastRecorded.get(key) ?? 0;
  if (now - recordedAt < recordIntervalMs()) return false;
  makeRateLimitSpace(now);
  lastRecorded.delete(key);
  lastRecorded.set(key, now);

  logger.warn("rejected Hub API request due to principal policy", denial);
  try {
    await centralLog({
      event: "hub_api_principal_denied",
      value: denial,
    });
  } catch (err) {
    logger.warn("failed to write Hub API principal denial", {
      err: `${err}`,
      method: denial.method,
      principal_type: denial.principal_type,
    });
  }
  return true;
}

export function resetHubApiPrincipalDenialsForTests(): void {
  lastRecorded.clear();
}
