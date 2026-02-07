import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { getSecretSettingsKey } from "@cocalc/database/settings/secret-settings";
import {
  decryptSecretSettingValue,
  encryptSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";

const MAX_PAYLOAD_BYTES = 2_000_000;

export type ExternalCredentialScope =
  | "account"
  | "project"
  | "organization"
  | "site";

export type ExternalCredentialSelector = {
  provider: string;
  kind: string;
  scope: ExternalCredentialScope;
  owner_account_id?: string;
  project_id?: string;
  organization_id?: string;
};

export type ExternalCredentialRecord = ExternalCredentialSelector & {
  id: string;
  payload: string;
  metadata: Record<string, any>;
  created: Date;
  updated: Date;
  revoked: Date | null;
  last_used: Date | null;
};

function pool() {
  return getPool();
}

function normalizeSelector(
  selector: ExternalCredentialSelector,
): ExternalCredentialSelector {
  return {
    provider: selector.provider.trim().toLowerCase(),
    kind: selector.kind.trim().toLowerCase(),
    scope: selector.scope,
    owner_account_id: selector.owner_account_id,
    project_id: selector.project_id,
    organization_id: selector.organization_id,
  };
}

function credentialAadName({
  provider,
  kind,
  scope,
}: {
  provider: string;
  kind: string;
  scope: string;
}): string {
  return `external_credentials:${provider}:${kind}:${scope}`;
}

function validatePayload(payload: string): void {
  if (!payload?.trim()) {
    throw Error("credential payload must not be empty");
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    throw Error("credential payload too large");
  }
}

async function encryptPayload(
  selector: ExternalCredentialSelector,
  payload: string,
): Promise<string> {
  const key = await getSecretSettingsKey();
  return encryptSecretSettingValue(
    credentialAadName(selector),
    payload,
    key,
    "default",
  );
}

async function decryptPayload(
  selector: ExternalCredentialSelector,
  encrypted_payload: string,
): Promise<string> {
  const key = await getSecretSettingsKey();
  return decryptSecretSettingValue(
    credentialAadName(selector),
    encrypted_payload,
    key,
  );
}

export async function upsertExternalCredential({
  selector,
  payload,
  metadata = {},
}: {
  selector: ExternalCredentialSelector;
  payload: string;
  metadata?: Record<string, any>;
}): Promise<{ id: string; created: boolean }> {
  const normalized = normalizeSelector(selector);
  validatePayload(payload);
  const encrypted_payload = await encryptPayload(normalized, payload);
  const id = randomUUID();

  const { rows } = await pool().query<{ id: string }>(
    `
WITH existing AS (
  SELECT id
  FROM external_credentials
  WHERE provider=$1
    AND kind=$2
    AND scope=$3
    AND owner_account_id IS NOT DISTINCT FROM $4
    AND project_id IS NOT DISTINCT FROM $5
    AND organization_id IS NOT DISTINCT FROM $6
    AND revoked IS NULL
  ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST
  LIMIT 1
),
updated AS (
  UPDATE external_credentials
  SET encrypted_payload=$7, metadata=$8, updated=NOW(), revoked=NULL
  WHERE id IN (SELECT id FROM existing)
  RETURNING id
)
INSERT INTO external_credentials (
  id,
  provider,
  kind,
  scope,
  owner_account_id,
  project_id,
  organization_id,
  encrypted_payload,
  metadata,
  created,
  updated
)
SELECT
  $9,
  $1,
  $2,
  $3,
  $4,
  $5,
  $6,
  $7,
  $8,
  NOW(),
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM updated)
RETURNING id
    `,
    [
      normalized.provider,
      normalized.kind,
      normalized.scope,
      normalized.owner_account_id ?? null,
      normalized.project_id ?? null,
      normalized.organization_id ?? null,
      encrypted_payload,
      metadata ?? {},
      id,
    ],
  );

  if (rows[0]?.id) {
    return { id: rows[0].id, created: true };
  }

  const { rows: currentRows } = await pool().query<{ id: string }>(
    `
SELECT id
FROM external_credentials
WHERE provider=$1
  AND kind=$2
  AND scope=$3
  AND owner_account_id IS NOT DISTINCT FROM $4
  AND project_id IS NOT DISTINCT FROM $5
  AND organization_id IS NOT DISTINCT FROM $6
  AND revoked IS NULL
ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST
LIMIT 1
    `,
    [
      normalized.provider,
      normalized.kind,
      normalized.scope,
      normalized.owner_account_id ?? null,
      normalized.project_id ?? null,
      normalized.organization_id ?? null,
    ],
  );
  if (!currentRows[0]?.id) {
    throw Error("failed to upsert external credential");
  }
  return { id: currentRows[0].id, created: false };
}

export async function getExternalCredential({
  selector,
  touchLastUsed = true,
}: {
  selector: ExternalCredentialSelector;
  touchLastUsed?: boolean;
}): Promise<ExternalCredentialRecord | undefined> {
  const normalized = normalizeSelector(selector);
  const { rows } = await pool().query<{
    id: string;
    provider: string;
    kind: string;
    scope: ExternalCredentialScope;
    owner_account_id: string | null;
    project_id: string | null;
    organization_id: string | null;
    encrypted_payload: string;
    metadata: Record<string, any> | null;
    created: Date;
    updated: Date;
    revoked: Date | null;
    last_used: Date | null;
  }>(
    `
SELECT
  id,
  provider,
  kind,
  scope,
  owner_account_id,
  project_id,
  organization_id,
  encrypted_payload,
  metadata,
  created,
  updated,
  revoked,
  last_used
FROM external_credentials
WHERE provider=$1
  AND kind=$2
  AND scope=$3
  AND owner_account_id IS NOT DISTINCT FROM $4
  AND project_id IS NOT DISTINCT FROM $5
  AND organization_id IS NOT DISTINCT FROM $6
  AND revoked IS NULL
ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST
LIMIT 1
    `,
    [
      normalized.provider,
      normalized.kind,
      normalized.scope,
      normalized.owner_account_id ?? null,
      normalized.project_id ?? null,
      normalized.organization_id ?? null,
    ],
  );
  const row = rows[0];
  if (!row) return undefined;

  if (touchLastUsed) {
    void pool().query(
      "UPDATE external_credentials SET last_used=NOW() WHERE id=$1",
      [row.id],
    );
  }

  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    scope: row.scope,
    owner_account_id: row.owner_account_id ?? undefined,
    project_id: row.project_id ?? undefined,
    organization_id: row.organization_id ?? undefined,
    payload: await decryptPayload(
      {
        provider: row.provider,
        kind: row.kind,
        scope: row.scope,
      },
      row.encrypted_payload,
    ),
    metadata: row.metadata ?? {},
    created: row.created,
    updated: row.updated,
    revoked: row.revoked,
    last_used: row.last_used,
  };
}
