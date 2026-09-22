/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const CODEX_SUBSCRIPTION_KIND = "codex-subscription-auth-json";
export const CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY = "cocalc_default";
export const CODEX_DEVICE_AUTH_LEASE_KIND = "codex-device-auth-lease";
export const EXTERNAL_CREDENTIAL_OPERATION_LEASE_KIND =
  "credential-operation-lease";
export const EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY = "lease_expires_at";

type PolicySelector = {
  provider: string;
  kind: string;
  scope: string;
};

export type ExternalCredentialProviderPolicy = {
  provider?: string;
  kind: string;
  scope: string;
  defaultMetadataKey?: string;
  leaseExpirationMetadataKey?: string;
};

// Store behavior is selected by trusted server policy, never by metadata from
// a browser or project host. Provider-neutral operation leases are available
// to future adapters without teaching the encrypted store about each provider.
const POLICIES: readonly ExternalCredentialProviderPolicy[] = [
  {
    provider: "openai",
    kind: CODEX_SUBSCRIPTION_KIND,
    scope: "account",
    defaultMetadataKey: CODEX_SUBSCRIPTION_DEFAULT_METADATA_KEY,
  },
  {
    provider: "openai",
    kind: CODEX_DEVICE_AUTH_LEASE_KIND,
    scope: "account",
    leaseExpirationMetadataKey: EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY,
  },
  {
    kind: EXTERNAL_CREDENTIAL_OPERATION_LEASE_KIND,
    scope: "account",
    leaseExpirationMetadataKey: EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY,
  },
];

export function externalCredentialProviderPolicy(
  selector: PolicySelector,
): ExternalCredentialProviderPolicy | undefined {
  const provider = selector.provider.trim().toLowerCase();
  const kind = selector.kind.trim().toLowerCase();
  const scope = selector.scope.trim().toLowerCase();
  return POLICIES.find(
    (policy) =>
      (policy.provider === undefined || policy.provider === provider) &&
      policy.kind === kind &&
      policy.scope === scope,
  );
}

export function defaultMetadataKeyForCredentialSelector(
  selector: PolicySelector,
): string | undefined {
  return externalCredentialProviderPolicy(selector)?.defaultMetadataKey;
}

export function leaseExpirationMetadataKeyForCredentialSelector(
  selector: PolicySelector,
): string | undefined {
  return externalCredentialProviderPolicy(selector)?.leaseExpirationMetadataKey;
}
