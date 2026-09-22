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
  defaultMetadataKeyForCredentialSelector,
  leaseExpirationMetadataKeyForCredentialSelector,
} from "./provider-policy";

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
