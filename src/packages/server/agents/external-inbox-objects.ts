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

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { R2ObjectStoreAuth } from "@cocalc/backend/r2";
import {
  deleteR2ObjectsConcurrently,
  getR2ObjectBuffer,
  listR2ObjectKeys,
  putR2ObjectFromBuffer,
} from "@cocalc/backend/r2";

export const EXTERNAL_INBOX_OBJECT_PREFIX = "agent-external-inbox/v1/";

export interface ExternalInboxObjectStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
  /** The first keys under prefix, in key order: at most limit. */
  list(prefix: string, limit: number): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
}

let forTesting: ExternalInboxObjectStore | null | undefined;

/**
 * The object store, or undefined when there is none. New files ("write") go
 * there only while R2 is the blob backend, and stay in Postgres otherwise.
 * Stored ones are read and removed ("read") whenever R2 credentials are
 * configured, so that a later change of backend strands nothing.
 */
export async function externalInboxObjects(
  purpose: "write" | "read",
): Promise<ExternalInboxObjectStore | undefined> {
  if (forTesting !== undefined) return forTesting ?? undefined;
  // Loaded when needed: it brings the database pool and settings along.
  const { resolveBlobR2Auth, resolveBlobStorageConfig } =
    await import("@cocalc/server/blobs/config");
  let auth: R2ObjectStoreAuth | undefined;
  if (purpose === "write") {
    const config = await resolveBlobStorageConfig();
    if (config.activeBackend === "r2") auth = config.r2?.auth;
  } else {
    auth = await resolveBlobR2Auth();
  }
  if (!auth) return undefined;
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
    list: (prefix, limit) => listR2ObjectKeys({ auth, prefix, limit }),
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

/** Where the objects this bay writes (as its accounts' home) begin. */
function bayPrefix(bay_id: string): string {
  return `${EXTERNAL_INBOX_OBJECT_PREFIX}${bay_id}/`;
}

/**
 * A file's key: the bay that wrote it (the account's home), then a day after
 * its message expires, so that each bay cleans only its own objects, a whole
 * past day at a time: every object, also one whose message was never stored
 * (a send refused after the upload) or was stored by a retry on another day.
 */
export function externalInboxObjectKey({
  bay_id = getConfiguredBayId(),
  account_id,
  attempt_id,
  idx,
  sha256,
  expires_at,
}: {
  bay_id?: string;
  account_id: string;
  attempt_id: string;
  idx: number;
  sha256: string;
  expires_at: number;
}): string {
  return `${bayPrefix(bay_id)}${utcDay(expires_at + DAY_MS)}/${account_id}/${attempt_id}/${idx}-${sha256}`;
}

/**
 * Removes this bay's objects of days before today, at most limit of them (a
 * full batch says more may be left); returns how many. Keys sort by day, so
 * the first limit keys hold the oldest days: one bounded listing finds them.
 */
export async function removeExpiredExternalInboxObjects({
  now = Date.now(),
  limit,
  bay_id = getConfiguredBayId(),
}: {
  now?: number;
  limit: number;
  bay_id?: string;
}): Promise<number> {
  const store = await externalInboxObjects("read");
  if (!store) return 0;
  const today = utcDay(now);
  const prefix = bayPrefix(bay_id);
  const expired = (await store.list(prefix, limit)).filter((key) => {
    const day = key.slice(prefix.length).split("/")[0];
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && day < today;
  });
  if (expired.length) await store.delete(expired);
  return expired.length;
}
