/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupReportHeaderSha256,
  verifyBackupExclusionReport,
} from "./backup-exclusion-report";
import type { VerifiedBackupExclusionInventory } from "./backup-exclusion-report";
import { getR2ObjectToFile, putR2ObjectFromFile } from "./r2";
import type { R2ObjectStoreAuth } from "./r2";

// Separate from the disposable browsing indexes: index retention must never
// remove evidence needed to explain a partial backup after host-data deletion.
const PREFIX = "project-backup-exclusions/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface BackupExclusionBinding {
  schema_version: 1;
  project_id: string;
  backup_id: string;
  source: {
    subvolume_uuid: string;
    snapshot_uuid: string;
    captured_at: string;
    generation: string;
  };
  policy_sha256: string;
  report: { sha256: string; header_sha256: string; bytes: number };
}

export interface BackupExclusionReadLimits {
  max_bytes: number;
  max_record_bytes: number;
  max_entries: number;
  max_path_depth: number;
}

export interface StoredBackupExclusionReport {
  binding: BackupExclusionBinding;
  object_key: string;
  inventory: VerifiedBackupExclusionInventory;
}

function invalid(): never {
  throw new Error("Invalid backup exclusion storage binding or limits");
}

function validUuid(value: unknown): boolean {
  return typeof value === "string" && UUID.test(value);
}

function validDigest(value: unknown): boolean {
  return typeof value === "string" && DIGEST.test(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// Copy only supported fields before the first await. An object-key binding must
// not change while its report is being verified/uploaded. This is validation,
// NOT authentication: callers must obtain this receipt from protected metadata.
function copyBinding(value: BackupExclusionBinding): BackupExclusionBinding {
  if (
    value?.schema_version !== 1 ||
    !validUuid(value.project_id) ||
    !validDigest(value.backup_id) ||
    !validUuid(value.source?.subvolume_uuid) ||
    !validUuid(value.source?.snapshot_uuid) ||
    typeof value.source?.generation !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value.source.generation) ||
    BigInt(value.source.generation) > (1n << 64n) - 1n ||
    typeof value.source?.captured_at !== "string" ||
    !Number.isFinite(Date.parse(value.source.captured_at)) ||
    new Date(value.source.captured_at).toISOString() !==
      value.source.captured_at ||
    !validDigest(value.policy_sha256) ||
    !validDigest(value.report?.sha256) ||
    !validDigest(value.report?.header_sha256) ||
    !positive(value.report?.bytes)
  )
    invalid();
  return {
    schema_version: 1,
    project_id: value.project_id,
    backup_id: value.backup_id,
    source: {
      subvolume_uuid: value.source.subvolume_uuid,
      snapshot_uuid: value.source.snapshot_uuid,
      captured_at: value.source.captured_at,
      generation: value.source.generation,
    },
    policy_sha256: value.policy_sha256,
    report: {
      sha256: value.report.sha256,
      header_sha256: value.report.header_sha256,
      bytes: value.report.bytes,
    },
  };
}

export function backupExclusionObjectKey(
  binding: BackupExclusionBinding,
): string {
  const copy = copyBinding(binding);
  return `${PREFIX}/${copy.project_id}/${copy.backup_id}/${backupReportHeaderSha256(copy)}.ndjson`;
}

interface StoreOptions {
  auth: R2ObjectStoreAuth;
  binding: BackupExclusionBinding;
  limits: BackupExclusionReadLimits;
  timeout_ms: number;
  signal?: AbortSignal;
}

function capture(options: StoreOptions) {
  const binding = copyBinding(options.binding);
  const limits = { ...options.limits };
  if (
    ![
      limits.max_bytes,
      limits.max_record_bytes,
      limits.max_entries,
      limits.max_path_depth,
    ].every(positive) ||
    limits.max_record_bytes > limits.max_bytes ||
    binding.report.bytes > limits.max_bytes ||
    !positive(options.timeout_ms) ||
    options.timeout_ms > 0x7fffffff
  )
    invalid();
  const deadline = AbortSignal.timeout(options.timeout_ms);
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  signal.throwIfAborted();
  return {
    binding,
    limits,
    signal,
    auth: { ...options.auth },
    object_key: backupExclusionObjectKey(binding),
  };
}

async function verifyFile(path: string, options: ReturnType<typeof capture>) {
  const inventory = await verifyBackupExclusionReport({
    ...options.limits,
    chunks: createReadStream(path, { signal: options.signal }),
    sha256: options.binding.report.sha256,
    header_sha256: options.binding.report.header_sha256,
    policy_sha256: options.binding.policy_sha256,
  });
  if (inventory.bytes !== options.binding.report.bytes) invalid();
  return inventory;
}

async function download(path: string, options: ReturnType<typeof capture>) {
  const result = await getR2ObjectToFile({
    auth: options.auth,
    key: options.object_key,
    outputPath: path,
    maxBytes: options.binding.report.bytes,
    signal: options.signal,
  });
  if (
    result.bytes !== options.binding.report.bytes ||
    result.sha256 !== options.binding.report.sha256
  ) {
    throw new Error("Backup exclusion object failed integrity verification");
  }
  return await verifyFile(path, options);
}

function nextWithAbort(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return iterator.next();
      })
      .then(
        (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}

/**
 * Persist a report produced from the captured source, then read it back before
 * returning a receipt. Input hashes/header and source identity must come from
 * the protected producer, never a project-supplied report. A receipt certifies
 * only report storage; it does not certify backup completeness or allow deletion.
 * The owning bay must durably record the binding before publishing a partial
 * outcome. Until then a failed publication may leave an unreferenced object,
 * never an authoritative partial backup.
 */
export async function storeBackupExclusionReport(
  options: StoreOptions & { chunks: AsyncIterable<Uint8Array> },
): Promise<StoredBackupExclusionReport> {
  const captured = capture(options);
  const chunks = options.chunks;
  const dir = await mkdtemp(join(tmpdir(), "cocalc-exclusion-upload-"));
  try {
    const path = join(dir, "report.ndjson");
    const input = chunks[Symbol.asyncIterator]();
    const file = await open(path, "wx", 0o600);
    let inputComplete = false;
    try {
      let bytes = 0;
      async function* staging() {
        while (true) {
          const next = await nextWithAbort(input, captured.signal);
          if (next.done) {
            inputComplete = true;
            break;
          }
          const chunk = next.value;
          captured.signal.throwIfAborted();
          if (
            !(chunk instanceof Uint8Array) ||
            chunk.byteLength > captured.binding.report.bytes - bytes
          )
            invalid();
          const owned = Buffer.from(chunk);
          bytes += owned.length;
          await file.writeFile(owned);
          yield owned;
        }
      }
      const inventory = await verifyBackupExclusionReport({
        ...captured.limits,
        chunks: staging(),
        sha256: captured.binding.report.sha256,
        header_sha256: captured.binding.report.header_sha256,
        policy_sha256: captured.binding.policy_sha256,
      });
      if (inventory.bytes !== captured.binding.report.bytes) invalid();
      await file.sync();
    } finally {
      // An arbitrary async producer may never settle next()/return(). Request
      // shutdown without letting it hold our private staging descriptor open.
      // The caller still owns supervision of the process producing the report.
      if (!inputComplete) {
        void Promise.resolve()
          .then(() => input.return?.())
          .catch(() => {});
      }
      await file.close();
    }
    await putR2ObjectFromFile({
      auth: captured.auth,
      key: captured.object_key,
      filePath: path,
      contentType: "application/x-ndjson",
      cacheControl: "private, no-store",
      payloadSha256: captured.binding.report.sha256,
      contentLength: captured.binding.report.bytes,
      signal: captured.signal,
    });
    const inventory = await download(join(dir, "verified.ndjson"), captured);
    return {
      binding: captured.binding,
      object_key: captured.object_key,
      inventory,
    };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

/**
 * Call only AFTER authorizing the requested project/backup. No storage key from
 * a request is accepted. No report prefix is exposed until complete validation.
 * The callback must finish consuming the stream before returning; the temporary
 * file is removed on success, error, cancellation and callback failure.
 */
export async function readBackupExclusionReport<T>(
  options: StoreOptions,
  consume: (
    report: StoredBackupExclusionReport,
    chunks: AsyncIterable<Uint8Array>,
  ) => Promise<T>,
): Promise<T> {
  const captured = capture(options);
  const dir = await mkdtemp(join(tmpdir(), "cocalc-exclusion-read-"));
  try {
    const path = join(dir, "report.ndjson");
    const inventory = await download(path, captured);
    const stream = createReadStream(path, { signal: captured.signal });
    try {
      return await consume(
        {
          binding: captured.binding,
          object_key: captured.object_key,
          inventory,
        },
        stream,
      );
    } finally {
      stream.destroy();
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}
