/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import {
  ANTHROPIC_API_KEY_KIND,
  ANTHROPIC_API_KEY_PROFILE_ID,
  ANTHROPIC_API_PROVIDER,
} from "@cocalc/util/ai/external-credential-profiles";
import {
  AccountCredentialBroker,
  type AccountCredentialBrokerStore,
  type AccountCredentialProviderAdapter,
} from "./account-broker";

export {
  ANTHROPIC_API_KEY_KIND,
  ANTHROPIC_API_KEY_PROFILE_ID,
  ANTHROPIC_API_PROVIDER,
} from "@cocalc/util/ai/external-credential-profiles";

const DEFAULT_VERIFY_URL = "https://api.anthropic.com/v1/models?limit=1";
const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 7_000;

type Fetch = typeof globalThis.fetch;

function normalizeApiKey(value: string): string {
  const apiKey = value.trim();
  if (
    apiKey.length < 20 ||
    apiKey.length > 512 ||
    /\s|[\x00-\x1f\x7f]/.test(apiKey)
  ) {
    throw new Error("Enter a valid Anthropic API key.");
  }
  return apiKey;
}

function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

async function verifyAnthropicApiKey({
  apiKey,
  fetchImpl,
  verifyUrl,
  timeoutMs,
}: {
  apiKey: string;
  fetchImpl: Fetch;
  verifyUrl: string;
  timeoutMs: number;
}): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(verifyUrl, {
      method: "GET",
      headers: {
        "anthropic-version": ANTHROPIC_API_VERSION,
        "x-api-key": apiKey,
      },
      signal: controller.signal,
    });
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Anthropic rejected this API key. Check the key and its permissions.",
      );
    }
    if (response.status === 429) {
      throw new Error(
        "Anthropic is rate-limiting API-key verification. Try again shortly.",
      );
    }
    if (response.status >= 500) {
      throw new Error(
        "Anthropic API-key verification is temporarily unavailable. Try again shortly.",
      );
    }
    throw new Error(
      `Anthropic could not verify this API key (HTTP ${response.status}).`,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        "Anthropic API-key verification timed out. Try again shortly.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function anthropicApiKeyAdapter({
  fetchImpl = globalThis.fetch,
  verifyUrl = DEFAULT_VERIFY_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  fetchImpl?: Fetch;
  verifyUrl?: string;
  timeoutMs?: number;
} = {}): AccountCredentialProviderAdapter<string> {
  if (!/^https:\/\//i.test(verifyUrl)) {
    throw new Error("Anthropic verification URL must use HTTPS");
  }
  return {
    profileId: ANTHROPIC_API_KEY_PROFILE_ID,
    provider: ANTHROPIC_API_PROVIDER,
    kind: ANTHROPIC_API_KEY_KIND,
    maxActive: 10,
    verify: async (input) => {
      const apiKey = normalizeApiKey(input);
      await verifyAnthropicApiKey({
        apiKey,
        fetchImpl,
        verifyUrl,
        timeoutMs,
      });
      return {
        payload: apiKey,
        identity: fingerprint(apiKey),
        metadata: {
          authentication: "api-key",
          billing: "anthropic-api",
          verified_at: new Date().toISOString(),
        },
      };
    },
    // Anthropic does not expose a stable account identity to ordinary API
    // keys. An explicit reconnect is therefore the supported key-rotation
    // operation for one CoCalc profile after the replacement is verified.
    sameIdentity: () => true,
  };
}

export function anthropicApiKeyBroker(
  options: {
    fetchImpl?: Fetch;
    verifyUrl?: string;
    timeoutMs?: number;
    store?: AccountCredentialBrokerStore;
  } = {},
): AccountCredentialBroker<string> {
  return new AccountCredentialBroker(
    anthropicApiKeyAdapter(options),
    options.store,
  );
}
