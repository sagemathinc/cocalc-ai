/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Where an external inbox keeps the files sent with its messages. With R2
// configured (the blob storage settings) they are private objects in the blob
// bucket, under a prefix of their own: the public blob Worker serves only
// blobs/v1/<uuid> keys, so nothing here is ever reachable without the
// server's R2 credentials. Without R2 (self-hosted), the bytes stay in the
// attachment row itself.

import {
  deleteR2ObjectsConcurrently,
  getR2ObjectBuffer,
  listR2ObjectKeys,
  putR2ObjectFromBuffer,
} from "@cocalc/backend/r2";
import { resolveBlobStorageConfig } from "@cocalc/server/blobs/config";

export const EXTERNAL_INBOX_OBJECT_PREFIX = "agent-external-inbox/v1/";

export interface ExternalInboxObjectStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
  list(prefix: string): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
}

let forTesting: ExternalInboxObjectStore | null | undefined;

/** The object store, or undefined when the bytes stay in Postgres. */
export async function externalInboxObjects(): Promise<
  ExternalInboxObjectStore | undefined
> {
  if (forTesting !== undefined) return forTesting ?? undefined;
  const config = await resolveBlobStorageConfig();
  if (config.activeBackend !== "r2" || !config.r2) return undefined;
  const auth = config.r2.auth;
  return {
    put: (key, data) =>
      putR2ObjectFromBuffer({
        auth,
        key,
        body: data,
        contentType: "application/octet-stream",
        cacheControl: "private, no-store",
      }),
    get: (key) => getR2ObjectBuffer({ auth, key }),
    list: (prefix) => listR2ObjectKeys({ auth, prefix }),
    delete: (keys) =>
      deleteR2ObjectsConcurrently({ auth, keys, concurrency: 8 }),
  };
}

/** null: no object store (Postgres); undefined: the configured one again. */
export function setExternalInboxObjectsForTesting(
  store: ExternalInboxObjectStore | null | undefined,
) {
  forTesting = store;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A file's key. It begins with a day after its message expires, so that
 * cleanup can drop whole past days: every object, also one whose message was
 * never stored (a send refused after the upload) or was stored by a retry on
 * another day.
 */
export function externalInboxObjectKey({
  account_id,
  attempt_id,
  idx,
  sha256,
  expires_at,
}: {
  account_id: string;
  attempt_id: string;
  idx: number;
  sha256: string;
  expires_at: number;
}): string {
  return `${EXTERNAL_INBOX_OBJECT_PREFIX}${utcDay(expires_at + DAY_MS)}/${account_id}/${attempt_id}/${idx}-${sha256}`;
}

/** Removes the objects of every day before today; returns how many. */
export async function removeExpiredExternalInboxObjects(
  now = Date.now(),
): Promise<number> {
  const store = await externalInboxObjects();
  if (!store) return 0;
  const today = utcDay(now);
  const expired = (await store.list(EXTERNAL_INBOX_OBJECT_PREFIX)).filter(
    (key) => {
      const day = key.slice(EXTERNAL_INBOX_OBJECT_PREFIX.length).split("/")[0];
      return /^\d{4}-\d{2}-\d{2}$/.test(day) && day < today;
    },
  );
  if (expired.length) await store.delete(expired);
  return expired.length;
}
