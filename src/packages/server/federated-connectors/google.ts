/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The two Google calls of a federated mint: the Security Token Service
// exchange of a signed assertion for a federated token, and the IAM
// Credentials call that turns it into a short-lived access token of one
// service account. Errors carry fixed codes only: never a token, an
// assertion or a response body.

import {
  ACCESS_TOKEN_LIFETIME_S,
  isGcpServiceAccount,
} from "@cocalc/util/ai/federated-connectors";

export const STS_TOKEN_URL = "https://sts.googleapis.com/v1/token";
const IAM_CREDENTIALS_URL =
  "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOKEN_LENGTH = 8192;

export type GoogleErrorKind = "deny" | "transient";

/** A failed Google call: a fixed code, never response or token bytes. */
export class GoogleCallError extends Error {
  constructor(
    readonly kind: GoogleErrorKind,
    readonly code: string,
    readonly status?: number,
    /** Milliseconds to wait before retrying, from Retry-After. */
    readonly retryAfterMs?: number,
  ) {
    super(`${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "GoogleCallError";
  }
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: "error";
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
}>;

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return;
  const trimmed = value.trim();
  if (/^[0-9]{1,6}$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return;
}

async function call(
  fetchImpl: FetchLike,
  code: string,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ data: any; date: number | undefined }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    throw new GoogleCallError("transient", `${code}_unreachable`);
  } finally {
    clearTimeout(timer);
  }
  const dateHeader = res.headers.get("date");
  const date = dateHeader ? Date.parse(dateHeader) : undefined;
  if (res.status === 429 || res.status >= 500) {
    throw new GoogleCallError(
      "transient",
      `${code}_unavailable`,
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  if (res.status < 200 || res.status >= 300) {
    // 400/401/403/404: the provider refused this identity or request.
    throw new GoogleCallError("deny", `${code}_refused`, res.status);
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new GoogleCallError("transient", `${code}_malformed`, res.status);
  }
  return { data, date: Number.isFinite(date) ? date : undefined };
}

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

/** Exchanges a signed assertion for a federated token (not usable alone). */
export async function exchangeAssertion({
  fetchImpl,
  assertion,
  exchangeAudience,
}: {
  fetchImpl: FetchLike;
  assertion: string;
  exchangeAudience: string;
}): Promise<{ federatedToken: string; date?: number }> {
  if (!exchangeAudience.startsWith("//iam.googleapis.com/projects/")) {
    throw new GoogleCallError("deny", "sts_bad_audience");
  }
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: exchangeAudience,
    scope: CLOUD_PLATFORM_SCOPE,
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: assertion,
  }).toString();
  const { data, date } = await call(fetchImpl, "sts", STS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!validToken(data?.access_token)) {
    throw new GoogleCallError("transient", "sts_malformed");
  }
  return { federatedToken: data.access_token, date };
}

/** A short-lived access token of one service account. */
export async function generateAccessToken({
  fetchImpl,
  federatedToken,
  serviceAccount,
  now,
  lifetimeSeconds = ACCESS_TOKEN_LIFETIME_S,
}: {
  fetchImpl: FetchLike;
  federatedToken: string;
  serviceAccount: string;
  now: number;
  lifetimeSeconds?: number;
}): Promise<{ accessToken: string; expiresAt: number }> {
  if (!isGcpServiceAccount(serviceAccount)) {
    throw new GoogleCallError("deny", "iam_bad_service_account");
  }
  if (
    !Number.isInteger(lifetimeSeconds) ||
    lifetimeSeconds < 60 ||
    lifetimeSeconds > ACCESS_TOKEN_LIFETIME_S
  ) {
    throw new GoogleCallError("deny", "iam_bad_lifetime");
  }
  const { data } = await call(
    fetchImpl,
    "iam",
    `${IAM_CREDENTIALS_URL}/${encodeURIComponent(serviceAccount)}:generateAccessToken`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${federatedToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: [CLOUD_PLATFORM_SCOPE],
        lifetime: `${lifetimeSeconds}s`,
      }),
    },
  );
  const expiresAt = Date.parse(`${data?.expireTime ?? ""}`);
  if (!validToken(data?.accessToken) || !Number.isFinite(expiresAt)) {
    throw new GoogleCallError("transient", "iam_malformed");
  }
  // Never trust a lifetime longer than the one requested.
  if (expiresAt > now + lifetimeSeconds * 1000 + 60_000) {
    throw new GoogleCallError("transient", "iam_unexpected_expiry");
  }
  return { accessToken: data.accessToken, expiresAt };
}
