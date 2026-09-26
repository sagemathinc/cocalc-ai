/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import {
  ANTHROPIC_API_KEY_KIND,
  ANTHROPIC_API_KEY_PROFILE_ID,
  ANTHROPIC_API_PROVIDER,
  anthropicApiKeyAdapter,
} from "./anthropic-api-key";

const API_KEY = "sk-ant-test-this-is-not-a-real-secret";

test("verifies an API key without inference and returns safe metadata", async () => {
  const fetchImpl = jest.fn(
    async () =>
      new Response('{"data":[]}', {
        status: 200,
      }),
  );
  const adapter = anthropicApiKeyAdapter({ fetchImpl });
  const verified = await adapter.verify(API_KEY, {
    operation: "create",
    accountId: "11111111-1111-4111-8111-111111111111",
  });

  expect(adapter).toMatchObject({
    profileId: ANTHROPIC_API_KEY_PROFILE_ID,
    provider: ANTHROPIC_API_PROVIDER,
    kind: ANTHROPIC_API_KEY_KIND,
    maxActive: 10,
  });
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://api.anthropic.com/v1/models?limit=1",
    expect.objectContaining({
      method: "GET",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": API_KEY,
      },
    }),
  );
  expect(verified).toEqual({
    payload: API_KEY,
    identity: createHash("sha256").update(API_KEY).digest("hex"),
    metadata: expect.objectContaining({
      authentication: "api-key",
      billing: "anthropic-api",
      verified_at: expect.any(String),
    }),
  });
  expect(JSON.stringify(verified.metadata)).not.toContain(API_KEY);
});

test.each([
  [401, "rejected this API key"],
  [403, "rejected this API key"],
  [429, "rate-limiting"],
  [503, "temporarily unavailable"],
  [418, "HTTP 418"],
] as const)(
  "maps HTTP %s to a safe verification error",
  async (status, text) => {
    const fetchImpl = jest.fn(
      async () => new Response(`provider body contains ${API_KEY}`, { status }),
    );
    const adapter = anthropicApiKeyAdapter({ fetchImpl });
    let message = "";
    try {
      await adapter.verify(API_KEY, {
        operation: "create",
        accountId: "11111111-1111-4111-8111-111111111111",
      });
    } catch (error) {
      message = `${error}`;
    }
    expect(message).toContain(text);
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain("provider body");
  },
);

test("rejects malformed keys before making a network request", async () => {
  const fetchImpl = jest.fn();
  const adapter = anthropicApiKeyAdapter({ fetchImpl });
  await expect(
    adapter.verify("not a key", {
      operation: "create",
      accountId: "11111111-1111-4111-8111-111111111111",
    }),
  ).rejects.toThrow("valid Anthropic API key");
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("requires HTTPS for a verification override", () => {
  expect(() =>
    anthropicApiKeyAdapter({ verifyUrl: "http://example.test/v1/models" }),
  ).toThrow("must use HTTPS");
});

test("explicit reconnect permits a verified API-key rotation", () => {
  const adapter = anthropicApiKeyAdapter();
  expect(adapter.sameIdentity?.("old-fingerprint", "new-fingerprint")).toBe(
    true,
  );
});
