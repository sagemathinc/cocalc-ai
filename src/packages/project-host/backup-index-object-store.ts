/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import getLogger from "@cocalc/backend/logger";
import { getR2ObjectToFile, putR2ObjectFromFile } from "@cocalc/backend/r2";
import type { ProjectBackupIndexStoreConfig } from "@cocalc/conat/hub/api/hosts";

const logger = getLogger("project-host:backup-index-object-store");

export interface UploadedBackupIndexObject {
  object_key: string;
  compression: "gzip";
  sqlite_bytes: number;
  object_bytes: number;
  sha256: string;
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
  await putR2ObjectFromFile({
    auth: {
      endpoint: config.endpoint,
      accessKey: config.access_key_id,
      secretKey: config.secret_access_key,
      bucket: config.bucket,
      region: "auto",
    },
    key,
    filePath,
    payloadSha256: sha256,
    contentLength: bytes,
    contentType: "application/gzip",
  });
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
  return await getR2ObjectToFile({
    auth: {
      endpoint: config.endpoint,
      accessKey: config.access_key_id,
      secretKey: config.secret_access_key,
      bucket: config.bucket,
      region: "auto",
    },
    key,
    outputPath,
  });
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
