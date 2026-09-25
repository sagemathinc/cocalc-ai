/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import {
  updateExternalCredentialPayloadLocked,
  type ExternalCredentialRecord,
} from "./store";

const CODEX_SUBSCRIPTION_SELECTOR = {
  provider: "openai",
  kind: "codex-subscription-auth-json",
  scope: "account" as const,
};
const DEFAULT_REFRESH_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TIMEOUT_MS = 7_000;

type Fetch = typeof globalThis.fetch;

type RefreshResponse = {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
};

export type CodexSubscriptionAuthRefreshResult = {
  payload: string;
  updated: Date;
  refreshed: boolean;
};

export function hashCodexAccessToken(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

function reauthError(): Error {
  return new Error(
    "ChatGPT sign-in has expired. Sign in again with ChatGPT in CoCalc, then retry.",
  );
}

function parseAuthJson(payload: string): {
  parsed: Record<string, any>;
  accessToken: string;
  refreshToken: string;
} {
  let parsed: any;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw reauthError();
  }
  const accessToken = `${parsed?.tokens?.access_token ?? ""}`.trim();
  const refreshToken = `${parsed?.tokens?.refresh_token ?? ""}`.trim();
  if (!accessToken || !refreshToken) {
    throw reauthError();
  }
  return { parsed, accessToken, refreshToken };
}

function refreshErrorCode(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const error = (value as any).error;
  if (typeof error === "string") return error.trim().toLowerCase();
  if (error && typeof error === "object") {
    const code = `${(error as any).code ?? ""}`.trim().toLowerCase();
    if (code) return code;
  }
  return `${(value as any).code ?? ""}`.trim().toLowerCase();
}

function isPermanentRefreshFailure(status: number, body: unknown): boolean {
  const code = refreshErrorCode(body);
  return (
    status === 401 ||
    code === "invalid_grant" ||
    code === "refresh_token_expired" ||
    code === "refresh_token_reused" ||
    code === "refresh_token_invalidated"
  );
}

async function requestRefreshedTokens({
  refreshToken,
  fetchImpl,
  timeoutMs,
}: {
  refreshToken: string;
  fetchImpl: Fetch;
  timeoutMs: number;
}): Promise<RefreshResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(
      process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim() ||
        DEFAULT_REFRESH_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id:
            process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID?.trim() ||
            DEFAULT_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        signal: controller.signal,
      },
    );
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      if (isPermanentRefreshFailure(response.status, body)) {
        throw reauthError();
      }
      throw new Error(
        `Unable to refresh ChatGPT sign-in right now (OpenAI returned HTTP ${response.status}). Retry shortly.`,
      );
    }
    if (!body || typeof body !== "object") {
      throw new Error(
        "Unable to refresh ChatGPT sign-in because OpenAI returned an invalid response. Retry shortly.",
      );
    }
    return body as RefreshResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        "Refreshing ChatGPT sign-in timed out. Retry shortly; if this persists, sign in again.",
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function applyRefreshResponse({
  credential,
  parsed,
  response,
}: {
  credential: ExternalCredentialRecord;
  parsed: Record<string, any>;
  response: RefreshResponse;
}): { payload: string; metadata: Record<string, any> } {
  const accessToken = `${response.access_token ?? ""}`.trim();
  if (!accessToken) {
    throw new Error(
      "Unable to refresh ChatGPT sign-in because OpenAI did not return a new access token. Sign in again.",
    );
  }
  const tokens = { ...(parsed.tokens ?? {}), access_token: accessToken };
  if (`${response.id_token ?? ""}`.trim()) {
    tokens.id_token = response.id_token;
  }
  if (`${response.refresh_token ?? ""}`.trim()) {
    tokens.refresh_token = response.refresh_token;
  }
  return {
    payload: JSON.stringify({
      ...parsed,
      tokens,
      last_refresh: new Date().toISOString(),
    }),
    metadata: {
      ...credential.metadata,
      refreshed_by: "cocalc",
    },
  };
}

export async function refreshCodexSubscriptionAuth({
  ownerAccountId,
  credentialId,
  previousAccessTokenHash,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  ownerAccountId: string;
  credentialId?: string;
  previousAccessTokenHash: string;
  fetchImpl?: Fetch;
  timeoutMs?: number;
}): Promise<CodexSubscriptionAuthRefreshResult> {
  const owner = ownerAccountId.trim();
  const previousHash = previousAccessTokenHash.trim().toLowerCase();
  if (!owner) throw new Error("ownerAccountId must be specified");
  if (!/^[a-f0-9]{64}$/.test(previousHash)) {
    throw new Error("previousAccessTokenHash must be a SHA-256 hash");
  }

  let refreshed = false;
  const credential = await updateExternalCredentialPayloadLocked({
    selector: {
      ...CODEX_SUBSCRIPTION_SELECTOR,
      owner_account_id: owner,
    },
    id: credentialId,
    update: async (current) => {
      const { parsed, accessToken, refreshToken } = parseAuthJson(
        current.payload,
      );
      if (hashCodexAccessToken(accessToken) !== previousHash) {
        return undefined;
      }
      const response = await requestRefreshedTokens({
        refreshToken,
        fetchImpl,
        timeoutMs,
      });
      refreshed = true;
      return applyRefreshResponse({ credential: current, parsed, response });
    },
  });
  if (!credential) {
    throw new Error(
      "ChatGPT sign-in is no longer connected. Sign in again with ChatGPT in CoCalc.",
    );
  }
  return {
    payload: credential.payload,
    updated: credential.updated,
    refreshed,
  };
}
