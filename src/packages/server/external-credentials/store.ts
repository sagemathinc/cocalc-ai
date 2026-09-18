import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import {
  decryptSecretStorageValue,
  encryptSecretStorageValue,
} from "@cocalc/database/settings/secret-settings";

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

export type ExternalCredentialSummary = ExternalCredentialSelector & {
  id: string;
  metadata: Record<string, any>;
  created: Date;
  updated: Date;
  revoked: Date | null;
  last_used: Date | null;
};

export type ExternalCredentialPayloadUpdate = {
  payload: string;
  metadata?: Record<string, any>;
};

type ExternalCredentialRow = {
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

function selectorValues(selector: ExternalCredentialSelector) {
  return [
    selector.provider,
    selector.kind,
    selector.scope,
    selector.owner_account_id ?? null,
    selector.project_id ?? null,
    selector.organization_id ?? null,
  ] as const;
}

async function rowToRecord(
  row: ExternalCredentialRow,
): Promise<ExternalCredentialRecord> {
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

const EXTERNAL_CREDENTIAL_COLUMNS = `
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
  last_used`;

function ownershipClause(startIndex = 2): string {
  return `provider=$${startIndex}
    AND kind=$${startIndex + 1}
    AND scope=$${startIndex + 2}
    AND owner_account_id IS NOT DISTINCT FROM $${startIndex + 3}
    AND project_id IS NOT DISTINCT FROM $${startIndex + 4}
    AND organization_id IS NOT DISTINCT FROM $${startIndex + 5}`;
}

async function encryptPayload(
  selector: ExternalCredentialSelector,
  payload: string,
): Promise<string> {
  return await encryptSecretStorageValue(credentialAadName(selector), payload);
}

async function decryptPayload(
  selector: ExternalCredentialSelector,
  encrypted_payload: string,
): Promise<string> {
  const result = await decryptSecretStorageValue(
    credentialAadName(selector),
    encrypted_payload,
  );
  return result.value;
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

export async function createExternalCredential({
  selector,
  payload,
  metadata = {},
  maxActive,
  deduplicateMetadata,
}: {
  selector: ExternalCredentialSelector;
  payload: string;
  metadata?: Record<string, any>;
  maxActive?: number;
  deduplicateMetadata?: { key: string; value: string };
}): Promise<{ id: string; created: boolean }> {
  const normalized = normalizeSelector(selector);
  validatePayload(payload);
  const encryptedPayload = await encryptPayload(normalized, payload);
  const id = randomUUID();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `external-credential:${selectorValues(normalized).join(":")}`,
    ]);
    if (deduplicateMetadata) {
      const { rows } = await client.query<{ id: string }>(
        `
SELECT id
FROM external_credentials
WHERE ${ownershipClause(1)}
  AND revoked IS NULL
  AND metadata->>$7 = $8
ORDER BY created ASC
LIMIT 1
FOR UPDATE
        `,
        [
          ...selectorValues(normalized),
          deduplicateMetadata.key,
          deduplicateMetadata.value,
        ],
      );
      const duplicate = rows[0];
      if (duplicate) {
        await client.query(
          `
UPDATE external_credentials
SET encrypted_payload=$2,
    metadata=COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
    updated=NOW()
WHERE id=$1 AND revoked IS NULL
          `,
          [duplicate.id, encryptedPayload, metadata],
        );
        await client.query("COMMIT");
        return { id: duplicate.id, created: false };
      }
    }
    if (maxActive != null) {
      const limit = Math.max(1, Math.floor(maxActive));
      const { rows } = await client.query<{ count: string }>(
        `
SELECT COUNT(*)::text AS count
FROM external_credentials
WHERE ${ownershipClause(1)} AND revoked IS NULL
        `,
        [...selectorValues(normalized)],
      );
      if (Number(rows[0]?.count ?? 0) >= limit) {
        throw new Error(`at most ${limit} active credentials are allowed`);
      }
    }
    await client.query(
      `
INSERT INTO external_credentials (
  id, provider, kind, scope, owner_account_id, project_id,
  organization_id, encrypted_payload, metadata, created, updated
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
      `,
      [id, ...selectorValues(normalized), encryptedPayload, metadata],
    );
    await client.query("COMMIT");
    return { id, created: true };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

export async function getExternalCredentialById({
  id,
  selector,
  touchLastUsed = true,
}: {
  id: string;
  selector: ExternalCredentialSelector;
  touchLastUsed?: boolean;
}): Promise<ExternalCredentialRecord | undefined> {
  const normalized = normalizeSelector(selector);
  const { rows } = await pool().query<ExternalCredentialRow>(
    `
SELECT ${EXTERNAL_CREDENTIAL_COLUMNS}
FROM external_credentials
WHERE id=$1 AND ${ownershipClause(2)} AND revoked IS NULL
LIMIT 1
    `,
    [id, ...selectorValues(normalized)],
  );
  const row = rows[0];
  if (!row) return undefined;
  if (touchLastUsed) {
    void pool().query(
      "UPDATE external_credentials SET last_used=NOW() WHERE id=$1 AND revoked IS NULL",
      [id],
    );
  }
  return await rowToRecord(row);
}

export async function updateExternalCredentialById({
  id,
  selector,
  payload,
  metadata,
}: {
  id: string;
  selector: ExternalCredentialSelector;
  payload: string;
  metadata: Record<string, any>;
}): Promise<boolean> {
  const normalized = normalizeSelector(selector);
  validatePayload(payload);
  const encryptedPayload = await encryptPayload(normalized, payload);
  const { rowCount } = await pool().query(
    `
UPDATE external_credentials
SET encrypted_payload=$8,
    metadata=COALESCE(metadata, '{}'::jsonb) || $9::jsonb,
    updated=NOW()
WHERE id=$1 AND ${ownershipClause(2)} AND revoked IS NULL
    `,
    [id, ...selectorValues(normalized), encryptedPayload, metadata],
  );
  return !!rowCount;
}

export async function updateExternalCredentialLabelById({
  id,
  selector,
  label,
}: {
  id: string;
  selector: ExternalCredentialSelector;
  label?: string;
}): Promise<boolean> {
  const normalized = normalizeSelector(selector);
  const { rowCount } = await pool().query(
    `
UPDATE external_credentials
SET metadata = CASE
      WHEN $8::text IS NULL THEN COALESCE(metadata, '{}'::jsonb) - 'label'
      ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{label}', to_jsonb($8::text), true)
    END,
    updated=NOW()
WHERE id=$1 AND ${ownershipClause(2)} AND revoked IS NULL
    `,
    [id, ...selectorValues(normalized), label ?? null],
  );
  return !!rowCount;
}

export async function ensureDefaultExternalCredential({
  selector,
  metadataKey,
}: {
  selector: ExternalCredentialSelector;
  metadataKey: string;
}): Promise<ExternalCredentialSummary | undefined> {
  const normalized = normalizeSelector(selector);
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `external-credential:${selectorValues(normalized).join(":")}`,
    ]);
    const { rows } = await client.query<ExternalCredentialRow>(
      `
SELECT ${EXTERNAL_CREDENTIAL_COLUMNS}
FROM external_credentials
WHERE ${ownershipClause(1)}
  AND ((metadata->>$7 = 'true') OR revoked IS NULL)
ORDER BY (metadata->>$7 = 'true') DESC,
         (revoked IS NULL) DESC,
         updated DESC NULLS LAST,
         created DESC NULLS LAST
FOR UPDATE
      `,
      [...selectorValues(normalized), metadataKey],
    );
    const row = rows[0];
    if (!row) {
      await client.query("COMMIT");
      return undefined;
    }
    if (row.revoked) {
      await client.query("COMMIT");
      return undefined;
    }
    if (row.metadata?.[metadataKey] !== true) {
      await client.query(
        `
UPDATE external_credentials
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object($2::text, true),
    updated=NOW()
WHERE id=$1 AND revoked IS NULL
        `,
        [row.id, metadataKey],
      );
      row.metadata = { ...(row.metadata ?? {}), [metadataKey]: true };
      row.updated = new Date();
    }
    await client.query("COMMIT");
    const { encrypted_payload: _, ...summary } = row;
    return {
      ...summary,
      owner_account_id: row.owner_account_id ?? undefined,
      project_id: row.project_id ?? undefined,
      organization_id: row.organization_id ?? undefined,
      metadata: row.metadata ?? {},
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
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

export async function updateExternalCredentialPayloadLocked({
  selector,
  id,
  update,
}: {
  selector: ExternalCredentialSelector;
  id?: string;
  update: (
    credential: ExternalCredentialRecord,
  ) => Promise<ExternalCredentialPayloadUpdate | undefined>;
}): Promise<ExternalCredentialRecord | undefined> {
  const normalized = normalizeSelector(selector);
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
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
WHERE ($7::uuid IS NULL OR id=$7::uuid)
  AND provider=$1
  AND kind=$2
  AND scope=$3
  AND owner_account_id IS NOT DISTINCT FROM $4
  AND project_id IS NOT DISTINCT FROM $5
  AND organization_id IS NOT DISTINCT FROM $6
  AND revoked IS NULL
ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST
LIMIT 1
FOR UPDATE
      `,
      [
        normalized.provider,
        normalized.kind,
        normalized.scope,
        normalized.owner_account_id ?? null,
        normalized.project_id ?? null,
        normalized.organization_id ?? null,
        id ?? null,
      ],
    );
    const row = rows[0];
    if (!row) {
      await client.query("COMMIT");
      return undefined;
    }

    let credential: ExternalCredentialRecord = {
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
    const next = await update(credential);
    if (next) {
      validatePayload(next.payload);
      const encryptedPayload = await encryptPayload(normalized, next.payload);
      const metadata = next.metadata ?? credential.metadata;
      const { rows: updatedRows } = await client.query<{
        updated: Date;
        last_used: Date;
      }>(
        `
UPDATE external_credentials
SET encrypted_payload=$2, metadata=$3, updated=NOW(), last_used=NOW()
WHERE id=$1
RETURNING updated, last_used
        `,
        [row.id, encryptedPayload, metadata],
      );
      credential = {
        ...credential,
        payload: next.payload,
        metadata,
        updated: updatedRows[0]?.updated ?? new Date(),
        last_used: updatedRows[0]?.last_used ?? new Date(),
      };
    }
    await client.query("COMMIT");
    return credential;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

export async function hasExternalCredential({
  selector,
}: {
  selector: ExternalCredentialSelector;
}): Promise<boolean> {
  const normalized = normalizeSelector(selector);
  const { rows } = await pool().query<{ id: string }>(
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
  return !!rows[0];
}

export async function touchExternalCredential({
  selector,
  id,
}: {
  selector: ExternalCredentialSelector;
  id?: string;
}): Promise<boolean> {
  const normalized = normalizeSelector(selector);
  const { rowCount } = await pool().query(
    `
WITH target AS (
  SELECT id
  FROM external_credentials
  WHERE ($7::uuid IS NULL OR id=$7::uuid)
    AND provider=$1
    AND kind=$2
    AND scope=$3
    AND owner_account_id IS NOT DISTINCT FROM $4
    AND project_id IS NOT DISTINCT FROM $5
    AND organization_id IS NOT DISTINCT FROM $6
    AND revoked IS NULL
  ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST
  LIMIT 1
)
UPDATE external_credentials
SET last_used=NOW()
WHERE id IN (SELECT id FROM target)
    `,
    [
      normalized.provider,
      normalized.kind,
      normalized.scope,
      normalized.owner_account_id ?? null,
      normalized.project_id ?? null,
      normalized.organization_id ?? null,
      id ?? null,
    ],
  );
  return !!rowCount;
}

export async function listExternalCredentials({
  owner_account_id,
  includeRevoked = false,
  provider,
  kind,
  scope,
}: {
  owner_account_id: string;
  includeRevoked?: boolean;
  provider?: string;
  kind?: string;
  scope?: ExternalCredentialScope;
}): Promise<ExternalCredentialSummary[]> {
  const providerValue = provider?.trim().toLowerCase() || null;
  const kindValue = kind?.trim().toLowerCase() || null;
  const scopeValue = scope?.trim().toLowerCase() || null;
  const { rows } = await pool().query<{
    id: string;
    provider: string;
    kind: string;
    scope: ExternalCredentialScope;
    owner_account_id: string | null;
    project_id: string | null;
    organization_id: string | null;
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
  metadata,
  created,
  updated,
  revoked,
  last_used
FROM external_credentials
WHERE owner_account_id = $1
  AND ($2::text IS NULL OR provider = $2::text)
  AND ($3::text IS NULL OR kind = $3::text)
  AND ($4::text IS NULL OR scope = $4::text)
  AND ($5::boolean IS TRUE OR revoked IS NULL)
ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST
    `,
    [owner_account_id, providerValue, kindValue, scopeValue, includeRevoked],
  );
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    scope: row.scope,
    owner_account_id: row.owner_account_id ?? undefined,
    project_id: row.project_id ?? undefined,
    organization_id: row.organization_id ?? undefined,
    metadata: row.metadata ?? {},
    created: row.created,
    updated: row.updated,
    revoked: row.revoked,
    last_used: row.last_used,
  }));
}

export async function revokeExternalCredential({
  id,
  owner_account_id,
}: {
  id: string;
  owner_account_id?: string;
}): Promise<boolean> {
  const { rowCount } = await pool().query(
    `
UPDATE external_credentials
SET revoked=NOW(), updated=NOW()
WHERE id=$1
  AND ($2::uuid IS NULL OR owner_account_id = $2::uuid)
  AND revoked IS NULL
    `,
    [id, owner_account_id ?? null],
  );
  return !!rowCount;
}
