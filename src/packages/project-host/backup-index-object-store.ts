/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import getLogger from "@cocalc/backend/logger";
import type { ProjectBackupIndexStoreConfig } from "@cocalc/conat/hub/api/hosts";

const logger = getLogger("project-host:backup-index-object-store");

export interface UploadedBackupIndexObject {
  object_key: string;
  compression: "gzip";
  sqlite_bytes: number;
  object_bytes: number;
  sha256: string;
}

function hashHex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(
  key: string | Buffer,
  data: string,
  encoding?: "hex",
): Buffer | string {
  const hash = createHmac("sha256", key).update(data, "utf8");
  return encoding ? hash.digest(encoding) : hash.digest();
}

function getSignatureKey(secret: string, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp) as Buffer;
  const kRegion = hmac(kDate, "auto") as Buffer;
  const kService = hmac(kRegion, "s3") as Buffer;
  return hmac(kService, "aws4_request") as Buffer;
}

function toAmzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalizeObjectPath(bucket: string, key: string): string {
  const parts = [bucket, ...`${key}`.split("/").filter(Boolean)];
  return `/${parts.map(encodeRfc3986).join("/")}`;
}

function signedObjectHeaders({
  method,
  endpoint,
  accessKey,
  secretKey,
  bucket,
  key,
  payloadSha256,
  contentType,
}: {
  method: "PUT" | "GET";
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  key: string;
  payloadSha256: string;
  contentType?: string;
}): { url: string; canonicalUri: string; headers: Record<string, string> } {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:") {
    throw new Error("object store endpoint must use https");
  }
  const host = parsed.host;
  const canonicalUri = canonicalizeObjectPath(bucket, key);
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadSha256,
    "x-amz-date": amzDate,
  };
  if (contentType) {
    headers["content-type"] = contentType;
  }
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadSha256,
  ].join("\n");
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(secretKey, dateStamp);
  const signature = hmac(signingKey, stringToSign, "hex") as string;
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    url: `${parsed.origin}${canonicalUri}`,
    canonicalUri,
    headers,
  };
}

function normalizeKeyPrefix(prefix: string): string {
  return prefix.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function buildBackupIndexObjectKey({
  config,
  project_id,
  backup_id,
}: {
  config: ProjectBackupIndexStoreConfig;
  project_id: string;
  backup_id: string;
}): string {
  const prefix = normalizeKeyPrefix(config.key_prefix);
  return posix.join(
    prefix,
    project_id.slice(0, 2),
    project_id,
    `backup-${backup_id}.sqlite.gz`,
  );
}

async function gzipBackupIndex(
  inputPath: string,
  outputPath: string,
): Promise<{
  sqlite_bytes: number;
  object_bytes: number;
  sha256: string;
}> {
  const { size: sqlite_bytes } = await stat(inputPath);
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(inputPath),
    createGzip({ level: 9 }),
    new Transform({
      transform(chunk, _enc, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(outputPath),
  );
  const { size: object_bytes } = await stat(outputPath);
  return {
    sqlite_bytes,
    object_bytes,
    sha256: hash.digest("hex"),
  };
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function putObjectFile({
  config,
  key,
  filePath,
  sha256,
  bytes,
}: {
  config: ProjectBackupIndexStoreConfig;
  key: string;
  filePath: string;
  sha256: string;
  bytes: number;
}): Promise<void> {
  const { url, headers } = signedObjectHeaders({
    method: "PUT",
    endpoint: config.endpoint,
    accessKey: config.access_key_id,
    secretKey: config.secret_access_key,
    bucket: config.bucket,
    key,
    payloadSha256: sha256,
    contentType: "application/gzip",
  });
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...headers,
      "content-length": `${bytes}`,
    },
    body: createReadStream(filePath) as any,
    duplex: "half",
  } as any);
  if (!response.ok) {
    throw new Error(
      `backup index object upload failed (${response.status}): ${await readResponseText(response)}`,
    );
  }
}

async function getObjectFile({
  config,
  key,
  outputPath,
}: {
  config: ProjectBackupIndexStoreConfig;
  key: string;
  outputPath: string;
}): Promise<{ sha256: string; bytes: number }> {
  const { url, headers } = signedObjectHeaders({
    method: "GET",
    endpoint: config.endpoint,
    accessKey: config.access_key_id,
    secretKey: config.secret_access_key,
    bucket: config.bucket,
    key,
    payloadSha256: hashHex(""),
  });
  const response = await fetch(url, {
    method: "GET",
    headers,
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `backup index object download failed (${response.status}): ${await readResponseText(response)}`,
    );
  }
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(response.body as any),
    new Transform({
      transform(chunk, _enc, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(outputPath),
  );
  const { size: bytes } = await stat(outputPath);
  return { sha256: hash.digest("hex"), bytes };
}

export async function uploadBackupIndexObject({
  config,
  project_id,
  backup_id,
  input_path,
}: {
  config: ProjectBackupIndexStoreConfig;
  project_id: string;
  backup_id: string;
  input_path: string;
}): Promise<UploadedBackupIndexObject> {
  const tempDir = await mkdtemp(join(tmpdir(), "cocalc-backup-index-upload-"));
  const gzPath = join(tempDir, `backup-${backup_id}.sqlite.gz`);
  try {
    const object_key = buildBackupIndexObjectKey({
      config,
      project_id,
      backup_id,
    });
    const meta = await gzipBackupIndex(input_path, gzPath);
    await putObjectFile({
      config,
      key: object_key,
      filePath: gzPath,
      sha256: meta.sha256,
      bytes: meta.object_bytes,
    });
    return {
      object_key,
      compression: "gzip",
      sqlite_bytes: meta.sqlite_bytes,
      object_bytes: meta.object_bytes,
      sha256: meta.sha256,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch((err) => {
      logger.debug("backup index upload temp cleanup failed", {
        backup_id,
        err: `${err}`,
      });
    });
  }
}

export async function downloadBackupIndexObject({
  config,
  object_key,
  sha256,
  output_path,
}: {
  config: ProjectBackupIndexStoreConfig;
  object_key: string;
  sha256?: string | null;
  output_path: string;
}): Promise<void> {
  const tempDir = await mkdtemp(
    join(tmpdir(), "cocalc-backup-index-download-"),
  );
  const gzPath = join(tempDir, "index.sqlite.gz");
  const sqlitePath = join(tempDir, "index.sqlite");
  try {
    const downloaded = await getObjectFile({
      config,
      key: object_key,
      outputPath: gzPath,
    });
    if (sha256 && downloaded.sha256 !== sha256) {
      throw new Error(
        `backup index object checksum mismatch for ${object_key}: expected ${sha256}, got ${downloaded.sha256}`,
      );
    }
    await pipeline(
      createReadStream(gzPath),
      createGunzip(),
      createWriteStream(sqlitePath),
    );
    await mkdir(dirname(output_path), { recursive: true });
    await rename(sqlitePath, output_path);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch((err) => {
      logger.debug("backup index download temp cleanup failed", {
        object_key,
        err: `${err}`,
      });
    });
  }
}
