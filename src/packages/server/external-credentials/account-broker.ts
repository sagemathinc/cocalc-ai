/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import { is_valid_uuid_string as isValidUuid } from "@cocalc/util/misc";
import {
  ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY as IDENTITY_METADATA_KEY,
  ACCOUNT_CREDENTIAL_PROFILE_METADATA_KEY as PROFILE_METADATA_KEY,
} from "@cocalc/util/ai/external-credential-profiles";
import {
  createExternalCredentialRouted,
  getExternalCredentialByIdRouted,
  revokeAccountExternalCredentialRouted,
  updateExternalCredentialByIdRouted,
} from "./routing";
import {
  EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY,
  EXTERNAL_CREDENTIAL_OPERATION_LEASE_KIND,
} from "./provider-policy";
import type {
  ExternalCredentialRecord,
  ExternalCredentialSelector,
} from "./store";

const RESERVED_METADATA_KEYS = new Set([
  PROFILE_METADATA_KEY,
  IDENTITY_METADATA_KEY,
]);
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const MAX_METADATA_BYTES = 64 * 1024;
const logger = getLogger("server:external-credentials:account-broker");

export type VerifiedAccountCredential = {
  payload: string;
  /** Stable provider identity, not a bearer token or other secret. */
  identity: string;
  /** Provider-approved non-secret metadata only. */
  metadata?: Record<string, unknown>;
};

export type AccountCredentialVerificationContext = {
  operation: "create" | "reconnect";
  accountId: string;
  current?: {
    id: string;
    identity: string;
    metadata: Record<string, unknown>;
  };
};

export interface AccountCredentialProviderAdapter<Input> {
  profileId: string;
  provider: string;
  kind: string;
  maxActive?: number;
  defaultMetadataKey?: string;
  verify(
    input: Input,
    context: AccountCredentialVerificationContext,
  ): Promise<VerifiedAccountCredential>;
  sameIdentity?(current: string, replacement: string): boolean;
}

export interface AccountCredentialBrokerStore {
  runExclusive<T>(options: {
    accountId: string;
    provider: string;
    operation: string;
    callback: () => Promise<T>;
  }): Promise<T>;
  create(options: {
    selector: ExternalCredentialSelector;
    payload: string;
    metadata: Record<string, unknown>;
    maxActive?: number;
    deduplicateMetadata: { key: string; value: string };
    defaultMetadataKey?: string;
  }): Promise<{ id: string; created: boolean }>;
  getById(options: {
    id: string;
    selector: ExternalCredentialSelector;
    touchLastUsed?: boolean;
  }): Promise<ExternalCredentialRecord | undefined>;
  updateById(options: {
    id: string;
    selector: ExternalCredentialSelector;
    payload: string;
    metadata: Record<string, unknown>;
  }): Promise<boolean>;
  revoke(options: { id: string; accountId: string }): Promise<boolean>;
}

function normalizeToken(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`invalid account credential ${field}`);
  }
  return normalized;
}

function normalizeIdentity(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 512 ||
    /[\x00-\x1f\x7f]/.test(normalized)
  ) {
    throw new Error("invalid provider credential identity");
  }
  return normalized;
}

function normalizeAccountId(value: string): string {
  const accountId = value.trim().toLowerCase();
  if (!isValidUuid(accountId)) {
    throw new Error("invalid credential owner account");
  }
  return accountId;
}

function normalizeCredentialId(value: string): string {
  const credentialId = value.trim().toLowerCase();
  if (!isValidUuid(credentialId)) {
    throw new Error("invalid external credential id");
  }
  return credentialId;
}

function safeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (metadata == null) return {};
  if (
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    (Object.getPrototypeOf(metadata) !== Object.prototype &&
      Object.getPrototypeOf(metadata) !== null)
  ) {
    throw new Error("credential metadata must be a plain object");
  }
  for (const key of Object.keys(metadata)) {
    if (RESERVED_METADATA_KEYS.has(key)) {
      throw new Error(`credential metadata key '${key}' is reserved`);
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    throw new Error("credential metadata must be JSON serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
    throw new Error("credential metadata is too large");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function selector(
  adapter: Pick<AccountCredentialProviderAdapter<unknown>, "provider" | "kind">,
  accountId: string,
): ExternalCredentialSelector {
  return {
    provider: normalizeToken(adapter.provider, "provider"),
    kind: normalizeToken(adapter.kind, "kind"),
    scope: "account",
    owner_account_id: normalizeAccountId(accountId),
  };
}

function currentIdentity(
  record: ExternalCredentialRecord,
  profileId: string,
): string {
  const storedProfile = record.metadata[PROFILE_METADATA_KEY];
  const identity = record.metadata[IDENTITY_METADATA_KEY];
  if (storedProfile !== profileId || typeof identity !== "string") {
    throw new Error("credential is not managed by this provider profile");
  }
  return normalizeIdentity(identity);
}

export class AccountCredentialBroker<Input> {
  private readonly profileId: string;
  private readonly provider: string;
  private readonly kind: string;

  constructor(
    private readonly adapter: AccountCredentialProviderAdapter<Input>,
    private readonly store: AccountCredentialBrokerStore = routedAccountCredentialBrokerStore,
  ) {
    this.profileId = normalizeToken(adapter.profileId, "profile id");
    this.provider = normalizeToken(adapter.provider, "provider");
    this.kind = normalizeToken(adapter.kind, "kind");
  }

  async create(options: {
    accountId: string;
    input: Input;
  }): Promise<{ id: string; created: boolean }> {
    const accountId = normalizeAccountId(options.accountId);
    return await this.store.runExclusive({
      accountId,
      provider: this.provider,
      operation: "create",
      callback: async () => {
        const verified = await this.verify(options.input, {
          operation: "create",
          accountId,
        });
        return await this.store.create({
          selector: this.selector(accountId),
          payload: verified.payload,
          metadata: verified.metadata,
          maxActive: this.adapter.maxActive,
          deduplicateMetadata: {
            key: IDENTITY_METADATA_KEY,
            value: verified.identity,
          },
          defaultMetadataKey: this.adapter.defaultMetadataKey,
        });
      },
    });
  }

  async reconnect(options: {
    accountId: string;
    credentialId: string;
    input: Input;
  }): Promise<void> {
    const accountId = normalizeAccountId(options.accountId);
    const credentialId = normalizeCredentialId(options.credentialId);
    await this.store.runExclusive({
      accountId,
      provider: this.provider,
      operation: "reconnect",
      callback: async () => {
        const current = await this.requiredCredential({
          accountId,
          credentialId,
          touchLastUsed: false,
        });
        const identity = currentIdentity(current, this.profileId);
        const verified = await this.verify(options.input, {
          operation: "reconnect",
          accountId,
          current: {
            id: current.id,
            identity,
            metadata: current.metadata,
          },
        });
        const sameIdentity =
          this.adapter.sameIdentity?.(identity, verified.identity) ??
          identity === verified.identity;
        if (!sameIdentity) {
          throw new Error(
            "reconnected credential belongs to a different provider identity",
          );
        }
        const updated = await this.store.updateById({
          id: credentialId,
          selector: this.selector(accountId),
          payload: verified.payload,
          metadata: verified.metadata,
        });
        if (!updated) {
          throw new Error("credential was revoked during reconnect");
        }
      },
    });
  }

  /** Runtime admission must always request an exact, already-authorized ID. */
  async readExact(options: {
    accountId: string;
    credentialId: string;
    touchLastUsed?: boolean;
  }): Promise<ExternalCredentialRecord | undefined> {
    return await this.store.getById({
      id: normalizeCredentialId(options.credentialId),
      selector: this.selector(options.accountId),
      touchLastUsed: options.touchLastUsed,
    });
  }

  async revoke(options: {
    accountId: string;
    credentialId: string;
  }): Promise<boolean> {
    const accountId = normalizeAccountId(options.accountId);
    const credentialId = normalizeCredentialId(options.credentialId);
    return await this.store.runExclusive({
      accountId,
      provider: this.provider,
      operation: "revoke",
      callback: async () => {
        const current = await this.readExact({
          accountId,
          credentialId,
          touchLastUsed: false,
        });
        if (!current) return false;
        currentIdentity(current, this.profileId);
        return await this.store.revoke({ id: credentialId, accountId });
      },
    });
  }

  private selector(accountId: string): ExternalCredentialSelector {
    return selector({ provider: this.provider, kind: this.kind }, accountId);
  }

  private async requiredCredential(options: {
    accountId: string;
    credentialId: string;
    touchLastUsed: boolean;
  }): Promise<ExternalCredentialRecord> {
    const current = await this.readExact(options);
    if (!current) throw new Error("credential is unavailable or revoked");
    return current;
  }

  private async verify(
    input: Input,
    context: AccountCredentialVerificationContext,
  ): Promise<
    VerifiedAccountCredential & { metadata: Record<string, unknown> }
  > {
    const verified = await this.adapter.verify(input, context);
    if (typeof verified.payload !== "string" || !verified.payload.trim()) {
      throw new Error("provider returned an empty credential payload");
    }
    const identity = normalizeIdentity(verified.identity);
    return {
      payload: verified.payload,
      identity,
      metadata: {
        ...safeMetadata(verified.metadata),
        [PROFILE_METADATA_KEY]: this.profileId,
        [IDENTITY_METADATA_KEY]: identity,
      },
    };
  }
}

export const routedAccountCredentialBrokerStore: AccountCredentialBrokerStore =
  {
    runExclusive: async ({ accountId, provider, operation, callback }) => {
      const selector: ExternalCredentialSelector = {
        provider,
        kind: EXTERNAL_CREDENTIAL_OPERATION_LEASE_KIND,
        scope: "account",
        owner_account_id: accountId,
      };
      const lease = await createExternalCredentialRouted({
        selector,
        payload: randomUUID(),
        metadata: {
          operation,
          [EXTERNAL_CREDENTIAL_LEASE_EXPIRY_METADATA_KEY]: new Date(
            Date.now() + DEFAULT_LEASE_MS,
          ).toISOString(),
        },
        maxActive: 1,
      });
      try {
        return await callback();
      } finally {
        await revokeAccountExternalCredentialRouted({
          id: lease.id,
          owner_account_id: accountId,
        }).catch((error) => {
          logger.warn("failed to release account credential operation lease", {
            accountId,
            provider,
            leaseId: lease.id,
            error: `${error}`,
          });
        });
      }
    },
    create: async (options) => await createExternalCredentialRouted(options),
    getById: async (options) => await getExternalCredentialByIdRouted(options),
    updateById: async (options) =>
      await updateExternalCredentialByIdRouted(options),
    revoke: async ({ id, accountId }) =>
      await revokeAccountExternalCredentialRouted({
        id,
        owner_account_id: accountId,
      }),
  };

export const accountCredentialBrokerMetadataKeys = {
  profile: PROFILE_METADATA_KEY,
  identity: IDENTITY_METADATA_KEY,
} as const;
