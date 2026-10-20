/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  CODEX_DEVICE_AUTH_LEASE_KIND,
  CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY,
  CODEX_SUBSCRIPTION_KIND,
  EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY,
  EXTERNAL_CREDENTIAL_OPERATION_LEASE_KIND,
  CLAUDE_SUBSCRIPTION_EXPIRY_METADATA_KEY,
  CLAUDE_SUBSCRIPTION_KIND,
  defaultMetadataKeyForCredentialSelector,
  leaseExpirationMetadataKeyForCredentialSelector,
  limitExpiryMetadataKeyForCredentialSelector,
} from "./provider-policy";
import {
  ANTHROPIC_API_PROVIDER,
  CLAUDE_SUBSCRIPTION_KIND as UTIL_CLAUDE_SUBSCRIPTION_KIND,
} from "@cocalc/util/ai/external-credential-profiles";

test("expired Claude subscription tokens do not count against the create limit", () => {
  // The policy repeats util's values: keep them in step.
  expect(CLAUDE_SUBSCRIPTION_KIND).toBe(UTIL_CLAUDE_SUBSCRIPTION_KIND);
  expect(
    limitExpiryMetadataKeyForCredentialSelector({
      provider: ANTHROPIC_API_PROVIDER,
      kind: UTIL_CLAUDE_SUBSCRIPTION_KIND,
      scope: "account",
    }),
  ).toBe(CLAUDE_SUBSCRIPTION_EXPIRY_METADATA_KEY);
  expect(
    limitExpiryMetadataKeyForCredentialSelector({
      provider: "openai",
      kind: CODEX_SUBSCRIPTION_KIND,
      scope: "account",
    }),
  ).toBeUndefined();
});

test("retains the Codex default policy without coupling the store to Codex", () => {
  expect(
    defaultMetadataKeyForCredentialSelector({
      provider: " OpenAI ",
      kind: CODEX_SUBSCRIPTION_KIND.toUpperCase(),
      scope: "ACCOUNT",
    }),
  ).toBe(CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY);
  expect(
    defaultMetadataKeyForCredentialSelector({
      provider: "anthropic",
      kind: CODEX_SUBSCRIPTION_KIND,
      scope: "account",
    }),
  ).toBeUndefined();
});

test("supports provider-specific and provider-neutral operation leases", () => {
  expect(
    leaseExpirationMetadataKeyForCredentialSelector({
      provider: "openai",
      kind: CODEX_DEVICE_AUTH_LEASE_KIND,
      scope: "account",
    }),
  ).toBe(EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY);
  expect(
    leaseExpirationMetadataKeyForCredentialSelector({
      provider: "anthropic",
      kind: EXTERNAL_CREDENTIAL_OPERATION_LEASE_KIND,
      scope: "account",
    }),
  ).toBe(EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY);
  expect(
    leaseExpirationMetadataKeyForCredentialSelector({
      provider: "anthropic",
      kind: EXTERNAL_CREDENTIAL_OPERATION_LEASE_KIND,
      scope: "project",
    }),
  ).toBeUndefined();
});
