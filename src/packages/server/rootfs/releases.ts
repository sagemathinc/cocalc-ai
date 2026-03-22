/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import basePath from "@cocalc/backend/base-path";
import { data, secrets } from "@cocalc/backend/data";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import type {
  PublishProjectRootfsArtifact,
  RootfsReleaseArtifactAccess,
  RootfsReleaseArtifactBackend,
  RootfsReleaseArtifactFormat,
  RootfsReleaseArtifactKind,
} from "@cocalc/util/rootfs-images";
import { managedRootfsContentKey } from "@cocalc/util/rootfs-images";
import { v4 as uuid } from "uuid";

export const ROOTFS_RELEASE_ARTIFACT_ROUTE_PREFIX = "/rootfs/releases";
const ROOTFS_RELEASE_ARTIFACT_ROOT = join(data, "rootfs", "releases");
const ROOTFS_RELEASE_TOKEN_SECRET_PATH = join(
  secrets,
  "rootfs-release-artifact-token-key",
);
const ROOTFS_RELEASE_ARTIFACT_KIND: RootfsReleaseArtifactKind = "full";
const ROOTFS_RELEASE_ARTIFACT_FORMAT: RootfsReleaseArtifactFormat =
  "btrfs-send";
const ROOTFS_RELEASE_ARTIFACT_BACKEND: RootfsReleaseArtifactBackend =
  "hub-local";
const ROOTFS_RELEASE_UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;

type RootfsReleaseRow = {
  release_id: string;
  content_key: string;
  runtime_image: string;
  source_image: string | null;
  arch: string | null;
  size_bytes: number | null;
  artifact_kind: RootfsReleaseArtifactKind;
  artifact_format: RootfsReleaseArtifactFormat;
  artifact_backend: RootfsReleaseArtifactBackend;
  artifact_path: string;
  artifact_sha256: string;
  artifact_bytes: number;
  inspect_json: Record<string, any> | null;
};

type RootfsStoredArtifactMetadata = {
  artifact_sha256: string;
  artifact_bytes: number;
  uploaded_at: string;
};

type RootfsArtifactTokenPayload = {
  kind: "upload" | "download";
  host_id: string;
  content_key: string;
  exp: number;
};

function normalizeContentKey(content_key?: string): string {
  const value = `${content_key ?? ""}`.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid RootFS content key");
  }
  return value;
}

function artifactRelativePath(content_key: string): string {
  const key = normalizeContentKey(content_key);
  return `${key.slice(0, 2)}/${key}/full.btrfs`;
}

export function rootfsReleaseArtifactLocalPath(content_key: string): string {
  return join(ROOTFS_RELEASE_ARTIFACT_ROOT, artifactRelativePath(content_key));
}

function rootfsReleaseArtifactMetadataPath(content_key: string): string {
  return `${rootfsReleaseArtifactLocalPath(content_key)}.json`;
}

function rootfsReleaseArtifactUploadTempPath(
  content_key: string,
  upload_id: string,
): string {
  const normalizedUploadId = `${upload_id ?? ""}`.trim().toLowerCase();
  if (!/^[0-9a-f-]{16,64}$/.test(normalizedUploadId)) {
    throw new Error("invalid RootFS artifact upload id");
  }
  return `${rootfsReleaseArtifactLocalPath(content_key)}.upload-${normalizedUploadId}.tmp`;
}

function artifactRoute(content_key: string): string {
  return `${ROOTFS_RELEASE_ARTIFACT_ROUTE_PREFIX}/${normalizeContentKey(content_key)}/artifact`;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = normalized.length % 4;
  const padded =
    padLen === 0 ? normalized : normalized + "=".repeat(4 - padLen);
  return Buffer.from(padded, "base64");
}

let tokenSecretCache: Buffer | undefined;

async function getTokenSecret(): Promise<Buffer> {
  if (tokenSecretCache) return tokenSecretCache;
  let encoded = "";
  try {
    encoded = (await readFile(ROOTFS_RELEASE_TOKEN_SECRET_PATH, "utf8")).trim();
  } catch {}
  if (!encoded) {
    encoded = randomBytes(32).toString("base64");
    await mkdir(secrets, { recursive: true });
    await writeFile(ROOTFS_RELEASE_TOKEN_SECRET_PATH, encoded, { mode: 0o600 });
  }
  tokenSecretCache = Buffer.from(encoded, "base64");
  if (tokenSecretCache.length !== 32) {
    throw new Error("invalid RootFS artifact token secret length");
  }
  return tokenSecretCache;
}

async function signToken(payload: RootfsArtifactTokenPayload): Promise<string> {
  const secret = await getTokenSecret();
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest();
  return `${body}.${base64UrlEncode(sig)}`;
}

export async function verifyRootfsArtifactToken({
  token,
  kind,
  content_key,
}: {
  token?: string;
  kind: "upload" | "download";
  content_key: string;
}): Promise<RootfsArtifactTokenPayload> {
  const raw = `${token ?? ""}`.trim();
  if (!raw) {
    throw new Error("missing RootFS artifact token");
  }
  const [body, sig] = raw.split(".");
  if (!body || !sig) {
    throw new Error("invalid RootFS artifact token format");
  }
  const secret = await getTokenSecret();
  const expected = base64UrlEncode(
    createHmac("sha256", secret).update(body).digest(),
  );
  if (expected !== sig) {
    throw new Error("invalid RootFS artifact token signature");
  }
  const payload = JSON.parse(
    base64UrlDecode(body).toString("utf8"),
  ) as RootfsArtifactTokenPayload;
  if (payload.kind !== kind) {
    throw new Error("invalid RootFS artifact token kind");
  }
  if (payload.content_key !== normalizeContentKey(content_key)) {
    throw new Error("invalid RootFS artifact token content key");
  }
  if (!payload.host_id?.trim()) {
    throw new Error("invalid RootFS artifact token host_id");
  }
  if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) {
    throw new Error("expired RootFS artifact token");
  }
  return payload;
}

async function getArtifactBaseUrl(): Promise<string> {
  const { dns } = await getServerSettings();
  let url = `${dns ?? ""}`.trim();
  if (!url) {
    throw new Error("public site URL is not configured");
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  if (basePath?.length) {
    url = `${url.replace(/\/+$/, "")}${basePath.startsWith("/") ? "" : "/"}${basePath}`;
  }
  return url.replace(/\/+$/, "");
}

export async function issueRootfsReleaseArtifactUpload({
  host_id,
  content_key,
  ttl_ms = 15 * 60 * 1000,
}: {
  host_id: string;
  content_key: string;
  ttl_ms?: number;
}): Promise<{ url: string; method: "PUT"; chunk_bytes: number }> {
  const key = normalizeContentKey(content_key);
  const token = await signToken({
    kind: "upload",
    host_id,
    content_key: key,
    exp: Date.now() + ttl_ms,
  });
  const base = await getArtifactBaseUrl();
  return {
    method: "PUT",
    chunk_bytes: ROOTFS_RELEASE_UPLOAD_CHUNK_BYTES,
    url: `${base}${artifactRoute(key)}?token=${encodeURIComponent(token)}`,
  };
}

async function loadRootfsReleaseRowByContentKey(
  content_key: string,
): Promise<RootfsReleaseRow | null> {
  const pool = getPool("medium");
  const { rows } = await pool.query<RootfsReleaseRow>(
    `SELECT
      release_id,
      content_key,
      runtime_image,
      source_image,
      arch,
      size_bytes,
      artifact_kind,
      artifact_format,
      artifact_backend,
      artifact_path,
      artifact_sha256,
      artifact_bytes,
      inspect_json
    FROM rootfs_releases
    WHERE content_key=$1`,
    [normalizeContentKey(content_key)],
  );
  return rows[0] ?? null;
}

export async function loadRootfsReleaseByImage(
  image: string,
): Promise<RootfsReleaseRow | null> {
  const content_key = managedRootfsContentKey(image);
  if (!content_key) {
    return null;
  }
  return await loadRootfsReleaseRowByContentKey(content_key);
}

export async function readStoredRootfsArtifactMetadata(
  content_key: string,
): Promise<RootfsStoredArtifactMetadata | null> {
  const path = rootfsReleaseArtifactMetadataPath(content_key);
  try {
    return JSON.parse(
      await readFile(path, "utf8"),
    ) as RootfsStoredArtifactMetadata;
  } catch {
    return null;
  }
}

export async function hasStoredRootfsArtifact(
  content_key: string,
): Promise<boolean> {
  try {
    await stat(rootfsReleaseArtifactLocalPath(content_key));
    return true;
  } catch {
    return false;
  }
}

export async function storeUploadedRootfsReleaseArtifact({
  content_key,
  input,
}: {
  content_key: string;
  input: NodeJS.ReadableStream;
}): Promise<RootfsStoredArtifactMetadata> {
  const key = normalizeContentKey(content_key);
  const finalPath = rootfsReleaseArtifactLocalPath(key);
  const metaPath = rootfsReleaseArtifactMetadataPath(key);
  const tmpPath = `${finalPath}.upload-${randomUUID()}.tmp`;
  await mkdir(join(ROOTFS_RELEASE_ARTIFACT_ROOT, key.slice(0, 2), key), {
    recursive: true,
  });

  const hash = createHash("sha256");
  let bytes = 0;
  input.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  });

  try {
    await pipeline(input as any, createWriteStream(tmpPath));
    const uploaded: RootfsStoredArtifactMetadata = {
      artifact_sha256: hash.digest("hex"),
      artifact_bytes: bytes,
      uploaded_at: new Date().toISOString(),
    };

    if (await hasStoredRootfsArtifact(key)) {
      const existing = await readStoredRootfsArtifactMetadata(key);
      await rm(tmpPath, { force: true });
      if (
        existing &&
        existing.artifact_sha256 === uploaded.artifact_sha256 &&
        existing.artifact_bytes === uploaded.artifact_bytes
      ) {
        return existing;
      }
      throw new Error(`conflicting RootFS artifact already exists for ${key}`);
    }

    await rename(tmpPath, finalPath);
    await writeFile(metaPath, JSON.stringify(uploaded, null, 2));
    return uploaded;
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function computeStoredArtifactMetadata(
  path: string,
): Promise<RootfsStoredArtifactMetadata> {
  const hash = createHash("sha256");
  let bytes = 0;
  const input = createReadStream(path);
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  }
  return {
    artifact_sha256: hash.digest("hex"),
    artifact_bytes: bytes,
    uploaded_at: new Date().toISOString(),
  };
}

export async function appendUploadedRootfsReleaseArtifactChunk({
  content_key,
  upload_id,
  part,
  parts,
  input,
}: {
  content_key: string;
  upload_id: string;
  part: number;
  parts: number;
  input: NodeJS.ReadableStream;
}): Promise<{ complete: boolean; metadata?: RootfsStoredArtifactMetadata }> {
  const key = normalizeContentKey(content_key);
  if (!Number.isInteger(part) || part < 0) {
    throw new Error("invalid RootFS artifact chunk part");
  }
  if (!Number.isInteger(parts) || parts <= 0 || part >= parts) {
    throw new Error("invalid RootFS artifact chunk count");
  }
  const finalPath = rootfsReleaseArtifactLocalPath(key);
  const metaPath = rootfsReleaseArtifactMetadataPath(key);
  const tmpPath = rootfsReleaseArtifactUploadTempPath(key, upload_id);
  await mkdir(join(ROOTFS_RELEASE_ARTIFACT_ROOT, key.slice(0, 2), key), {
    recursive: true,
  });
  if (part === 0) {
    await rm(tmpPath, { force: true }).catch(() => {});
  } else {
    try {
      await stat(tmpPath);
    } catch {
      throw new Error(
        `RootFS artifact upload chunk ${part + 1}/${parts} is missing its temporary upload state`,
      );
    }
  }
  const writer = createWriteStream(tmpPath, {
    flags: part === 0 ? "w" : "a",
  });
  try {
    await pipeline(input as any, writer);
    if (part < parts - 1) {
      return { complete: false };
    }
    const uploaded = await computeStoredArtifactMetadata(tmpPath);
    if (await hasStoredRootfsArtifact(key)) {
      const existing = await readStoredRootfsArtifactMetadata(key);
      await rm(tmpPath, { force: true }).catch(() => {});
      if (
        existing &&
        existing.artifact_sha256 === uploaded.artifact_sha256 &&
        existing.artifact_bytes === uploaded.artifact_bytes
      ) {
        return { complete: true, metadata: existing };
      }
      throw new Error(`conflicting RootFS artifact already exists for ${key}`);
    }
    await rename(tmpPath, finalPath);
    await writeFile(metaPath, JSON.stringify(uploaded, null, 2));
    return { complete: true, metadata: uploaded };
  } catch (err) {
    writer.destroy();
    if (part === parts - 1) {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
    throw err;
  }
}

export async function upsertPublishedRootfsRelease({
  artifact,
}: {
  artifact: PublishProjectRootfsArtifact;
}): Promise<RootfsReleaseRow> {
  const content_key = normalizeContentKey(artifact.content_key);
  const metadata = await readStoredRootfsArtifactMetadata(content_key);
  if (!metadata) {
    throw new Error(
      `stored RootFS artifact metadata missing for content key ${content_key}`,
    );
  }
  const artifact_path = artifactRelativePath(content_key);
  const pool = getPool("medium");
  const existing = await loadRootfsReleaseRowByContentKey(content_key);
  const release_id = existing?.release_id ?? uuid();
  const { rows } = await pool.query<RootfsReleaseRow>(
    `INSERT INTO rootfs_releases
      (
        release_id,
        content_key,
        runtime_image,
        source_image,
        arch,
        size_bytes,
        artifact_kind,
        artifact_format,
        artifact_backend,
        artifact_path,
        artifact_sha256,
        artifact_bytes,
        inspect_json,
        created,
        updated
      )
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::JSONB, NOW(), NOW())
      ON CONFLICT (content_key) DO UPDATE SET
        runtime_image = EXCLUDED.runtime_image,
        source_image = EXCLUDED.source_image,
        arch = EXCLUDED.arch,
        size_bytes = COALESCE(EXCLUDED.size_bytes, rootfs_releases.size_bytes),
        artifact_kind = EXCLUDED.artifact_kind,
        artifact_format = EXCLUDED.artifact_format,
        artifact_backend = EXCLUDED.artifact_backend,
        artifact_path = EXCLUDED.artifact_path,
        artifact_sha256 = EXCLUDED.artifact_sha256,
        artifact_bytes = EXCLUDED.artifact_bytes,
        inspect_json = COALESCE(EXCLUDED.inspect_json, rootfs_releases.inspect_json),
        updated = NOW()
      RETURNING
        release_id,
        content_key,
        runtime_image,
        source_image,
        arch,
        size_bytes,
        artifact_kind,
        artifact_format,
        artifact_backend,
        artifact_path,
        artifact_sha256,
        artifact_bytes,
        inspect_json`,
    [
      release_id,
      content_key,
      artifact.image,
      artifact.source_image ?? null,
      artifact.arch ?? null,
      artifact.size_bytes ?? null,
      ROOTFS_RELEASE_ARTIFACT_KIND,
      ROOTFS_RELEASE_ARTIFACT_FORMAT,
      ROOTFS_RELEASE_ARTIFACT_BACKEND,
      artifact_path,
      metadata.artifact_sha256,
      metadata.artifact_bytes,
      artifact.inspect_data ? JSON.stringify(artifact.inspect_data) : null,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`failed to upsert RootFS release for ${content_key}`);
  }
  return row;
}

export async function issueRootfsReleaseArtifactAccess({
  host_id,
  image,
  ttl_ms = 15 * 60 * 1000,
}: {
  host_id: string;
  image: string;
  ttl_ms?: number;
}): Promise<RootfsReleaseArtifactAccess> {
  const release = await loadRootfsReleaseByImage(image);
  if (!release) {
    throw new Error(`RootFS release not found for image '${image}'`);
  }
  if (!(await hasStoredRootfsArtifact(release.content_key))) {
    throw new Error(
      `stored RootFS artifact missing for content key '${release.content_key}'`,
    );
  }
  const token = await signToken({
    kind: "download",
    host_id,
    content_key: release.content_key,
    exp: Date.now() + ttl_ms,
  });
  const base = await getArtifactBaseUrl();
  return {
    release_id: release.release_id,
    image: release.runtime_image,
    content_key: release.content_key,
    artifact_kind: release.artifact_kind,
    artifact_format: release.artifact_format,
    artifact_backend: release.artifact_backend,
    artifact_sha256: release.artifact_sha256,
    artifact_bytes: release.artifact_bytes,
    download_url: `${base}${artifactRoute(release.content_key)}?token=${encodeURIComponent(token)}`,
    inspect_data: release.inspect_json ?? undefined,
  };
}

export async function streamStoredRootfsReleaseArtifact(
  content_key: string,
  output: NodeJS.WritableStream,
): Promise<{ bytes: number; sha256?: string }> {
  const key = normalizeContentKey(content_key);
  const path = rootfsReleaseArtifactLocalPath(key);
  const metadata = await readStoredRootfsArtifactMetadata(key);
  await pipeline(createReadStream(path), output as any);
  return {
    bytes: metadata?.artifact_bytes ?? (await stat(path)).size,
    sha256: metadata?.artifact_sha256,
  };
}

export async function deleteStoredRootfsArtifact(
  content_key: string,
): Promise<void> {
  const key = normalizeContentKey(content_key);
  await rm(rootfsReleaseArtifactLocalPath(key), { force: true }).catch(
    () => {},
  );
  await rm(rootfsReleaseArtifactMetadataPath(key), { force: true }).catch(
    () => {},
  );
}

export function rootfsReleaseArtifactContentType(): string {
  return "application/octet-stream";
}
