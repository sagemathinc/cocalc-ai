/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { R2ObjectStoreAuth } from "@cocalc/backend/r2";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

export type BlobStorageBackend = "postgres" | "r2" | "auto";

export interface BlobStorageConfig {
  backend: BlobStorageBackend;
  activeBackend: "postgres" | "r2";
  r2?: {
    auth: R2ObjectStoreAuth;
    publicBaseUrl?: string;
  };
}

function trim(value: unknown): string {
  return `${value ?? ""}`.trim();
}

function env(name: string): string {
  return trim(process.env[name]);
}

function normalizeBackend(value: unknown): BlobStorageBackend {
  const backend = trim(value).toLowerCase();
  if (backend === "r2" || backend === "auto" || backend === "postgres") {
    return backend;
  }
  return "postgres";
}

function normalizedPublicBaseUrl(value: unknown): string | undefined {
  const raw = trim(value);
  if (!raw) return undefined;
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") {
    throw new Error("blob_r2_public_url must use https");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * The configured backend and R2 bucket credentials. With
 * COCALC_BLOB_STORAGE_BACKEND set, only the environment counts; otherwise
 * the environment overrides the site settings.
 */
async function resolveBlobStorageInputs(): Promise<{
  fromEnv: boolean;
  backend: BlobStorageBackend;
  auth?: R2ObjectStoreAuth;
  publicBaseUrl: () => string | undefined;
}> {
  const region = env("COCALC_BLOB_R2_REGION") || undefined;
  const envBackend = env("COCALC_BLOB_STORAGE_BACKEND");
  if (envBackend) {
    const accountId = env("COCALC_BLOB_R2_ACCOUNT_ID");
    const endpoint =
      env("COCALC_BLOB_R2_ENDPOINT") ||
      (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
    const accessKey = env("COCALC_BLOB_R2_ACCESS_KEY_ID");
    const secretKey = env("COCALC_BLOB_R2_SECRET_ACCESS_KEY");
    const bucket = env("COCALC_BLOB_R2_BUCKET");
    return {
      fromEnv: true,
      backend: normalizeBackend(envBackend),
      auth:
        endpoint && accessKey && secretKey && bucket
          ? { endpoint, accessKey, secretKey, bucket, region }
          : undefined,
      publicBaseUrl: () =>
        normalizedPublicBaseUrl(env("COCALC_BLOB_R2_PUBLIC_URL")),
    };
  }

  const settings = await getServerSettings();
  const accountId =
    env("COCALC_BLOB_R2_ACCOUNT_ID") || trim(settings.r2_account_id);
  const endpoint =
    env("COCALC_BLOB_R2_ENDPOINT") ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  const accessKey =
    env("COCALC_BLOB_R2_ACCESS_KEY_ID") || trim(settings.r2_access_key_id);
  const secretKey =
    env("COCALC_BLOB_R2_SECRET_ACCESS_KEY") ||
    trim(settings.r2_secret_access_key);
  const bucket =
    env("COCALC_BLOB_R2_BUCKET") ||
    trim(settings.blob_r2_bucket) ||
    (trim(settings.r2_bucket_prefix)
      ? `${trim(settings.r2_bucket_prefix)}-blobs`
      : "");
  return {
    fromEnv: false,
    backend: normalizeBackend(settings.blob_storage_backend),
    auth:
      endpoint && accessKey && secretKey && bucket
        ? { endpoint, accessKey, secretKey, bucket, region }
        : undefined,
    publicBaseUrl: () =>
      normalizedPublicBaseUrl(
        env("COCALC_BLOB_R2_PUBLIC_URL") || settings.blob_r2_public_url,
      ),
  };
}

export async function resolveBlobStorageConfig(): Promise<BlobStorageConfig> {
  const { fromEnv, backend, auth, publicBaseUrl } =
    await resolveBlobStorageInputs();
  // Validated even when unused, as before.
  const url = publicBaseUrl();
  if (backend === "r2" && !auth) {
    throw new Error(
      fromEnv
        ? "COCALC_BLOB_STORAGE_BACKEND is r2 but R2 endpoint, credentials, or blob bucket are not configured"
        : "blob_storage_backend is r2 but R2 endpoint, credentials, or blob bucket are not configured",
    );
  }
  if (backend === "postgres" || !auth) {
    return { backend, activeBackend: "postgres" };
  }
  return {
    backend,
    activeBackend: "r2",
    r2: { auth, publicBaseUrl: url },
  };
}

/**
 * The blob bucket's R2 credentials whenever they are configured, whatever
 * the backend: to read or remove objects written while R2 was the backend.
 */
export async function resolveBlobR2Auth(): Promise<
  R2ObjectStoreAuth | undefined
> {
  return (await resolveBlobStorageInputs()).auth;
}

export async function getBlobPublicUrl(
  uuid: string,
): Promise<string | undefined> {
  const config = await resolveBlobStorageConfig();
  if (config.activeBackend !== "r2" || !config.r2?.publicBaseUrl) {
    return undefined;
  }
  return `${config.r2.publicBaseUrl}/${uuid}`;
}
