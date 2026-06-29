/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuidsha1 } from "@cocalc/backend/misc_node";
import { db } from "@cocalc/database";
import { assertCanSaveBlobForAccount } from "@cocalc/server/membership/blob-limits";
import { callback2 } from "@cocalc/util/async-utils";
import { MAX_BLOB_SIZE } from "@cocalc/util/db-schema/blobs";
import { human_readable_size } from "@cocalc/util/misc";

export interface SaveBlobToDatabaseOptions {
  uuid?: string;
  blob: Buffer | Uint8Array;
  ttl?: unknown;
  project_id?: unknown;
  account_id?: unknown;
}

function normalizedOptionalString(value: unknown): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed || undefined;
}

function normalizedTtl(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const ttl = Number(value);
  return Number.isFinite(ttl) ? ttl : undefined;
}

export async function saveBlobToDatabase({
  uuid,
  blob,
  ttl,
  project_id,
  account_id,
}: SaveBlobToDatabaseOptions): Promise<void> {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const projectId = normalizedOptionalString(project_id);
  const accountId = normalizedOptionalString(account_id);

  if (!uuid) {
    throw Error("save_blob: missing uuid");
  }
  if (!projectId && !accountId) {
    throw Error("save_blob: missing project_id or account_id");
  }
  if (buffer.length > MAX_BLOB_SIZE) {
    throw Error(
      `save_blob: blobs are limited to ${human_readable_size(
        MAX_BLOB_SIZE,
      )} and you just tried to save one of size ${buffer.length / 1000000}MB`,
    );
  }
  if (uuid !== uuidsha1(buffer)) {
    throw Error(
      `save_blob: uuid=${uuid} must be derived from the Sha1 hash of blob, but it is not (possible malicious attack)`,
    );
  }

  await assertCanSaveBlobForAccount({
    account_id: accountId,
    project_id: projectId,
    uuid,
    blobSize: buffer.length,
  });

  const database = db();
  await callback2(database.save_blob.bind(database), {
    uuid,
    blob: buffer,
    ttl: normalizedTtl(ttl),
    project_id: projectId,
    account_id: accountId,
  });
}
