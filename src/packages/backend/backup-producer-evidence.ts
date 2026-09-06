/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  backupExclusionObjectKey,
  storeBackupExclusionReport,
} from "./backup-exclusion-store";
import type {
  BackupExclusionBinding,
  StoredBackupExclusionReport,
} from "./backup-exclusion-store";
import type { R2ObjectStoreAuth } from "./r2";
import type {
  BackupProducerEvidence,
  BackupOutcomeReceipt,
} from "@cocalc/util/types/backup-evidence";
export type { BackupProducerEvidence } from "@cocalc/util/types/backup-evidence";

const ROOT = "/var/lib/cocalc-rustic-reports";
const REPORT_PATH =
  /^\/var\/lib\/cocalc-rustic-reports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ndjson$/;
const DIGEST = /^[0-9a-f]{64}$/;

function invalid(): never {
  throw new Error("Invalid protected backup producer evidence");
}

function object(value: unknown): Record<string, any> {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    invalid();
  return value as Record<string, any>;
}

function uint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= (1n << 64n) - 1n
  );
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate only protected helper output, never user-supplied evidence. */
export function parseBackupProducerEvidence(
  value: unknown,
  project_id: string,
  backup_id: string,
): BackupProducerEvidence {
  const doc = object(value);
  const source = object(doc.source);
  const report = object(doc.report);
  const limits = object(doc.read_limits);
  if (
    doc.schema_version !== 1 ||
    !positive(doc.policy_version) ||
    !uint(doc.exclude_larger_than_bytes) ||
    doc.exclude_larger_than_bytes === "0" ||
    typeof doc.binary_sha256 !== "string" ||
    !DIGEST.test(doc.binary_sha256) ||
    !uint(doc.excluded_files) ||
    doc.outcome !==
      (doc.excluded_files === "0" ? "complete" : "partial_policy_exclusions") ||
    typeof doc.report_path !== "string" ||
    !REPORT_PATH.test(doc.report_path) ||
    ![
      limits.max_bytes,
      limits.max_record_bytes,
      limits.max_entries,
      limits.max_path_depth,
    ].every(positive) ||
    limits.max_record_bytes > 65536 ||
    limits.max_record_bytes > limits.max_bytes ||
    !positive(report.bytes) ||
    report.bytes > limits.max_bytes ||
    BigInt(doc.excluded_files) > BigInt(limits.max_entries)
  )
    invalid();
  const binding: BackupExclusionBinding = {
    schema_version: 1,
    project_id,
    backup_id,
    source: {
      subvolume_uuid: source.subvolume_uuid,
      snapshot_uuid: source.snapshot_uuid,
      captured_at: source.captured_at,
      generation: source.generation,
    },
    policy_sha256: doc.policy_sha256,
    report: {
      bytes: report.bytes,
      sha256: report.sha256,
      header_sha256: report.header_sha256,
    },
  };
  // Reuse the durable store's exact UUID/digest/date/u64 binding contract.
  backupExclusionObjectKey(binding);
  return {
    binding,
    policy_version: doc.policy_version,
    exclude_larger_than_bytes: doc.exclude_larger_than_bytes,
    binary_sha256: doc.binary_sha256,
    outcome: doc.outcome,
    excluded_files: doc.excluded_files,
    report_path: doc.report_path,
    read_limits: {
      max_bytes: limits.max_bytes,
      max_record_bytes: limits.max_record_bytes,
      max_entries: limits.max_entries,
      max_path_depth: limits.max_path_depth,
    },
  };
}

/**
 * Publish the anchored root-owned report and await its owning-bay record before
 * the caller may use the result. The callback MUST durably record the receipt;
 * an upload alone is not backup coverage or lifecycle deletion authority.
 */
export async function acceptBackupProducerEvidence({
  evidence,
  auth,
  timeout_ms,
  record,
}: {
  evidence: BackupProducerEvidence;
  auth: R2ObjectStoreAuth;
  timeout_ms: number;
  record: (receipt: StoredBackupExclusionReport) => Promise<void>;
}): Promise<StoredBackupExclusionReport> {
  // Capture and revalidate caller-owned objects before yielding.
  const captured = parseBackupProducerEvidence(
    {
      schema_version: 1,
      ...evidence,
      source: evidence.binding.source,
      report: evidence.binding.report,
      policy_sha256: evidence.binding.policy_sha256,
    },
    evidence.binding.project_id,
    evidence.binding.backup_id,
  );
  const authSnapshot = { ...auth };
  const directory = await lstat(ROOT);
  if (
    !directory.isDirectory() ||
    directory.uid !== 0 ||
    (directory.mode & 0o027) !== 0
  )
    invalid();
  const file = await open(
    captured.report_path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o440 ||
      stat.size !== captured.binding.report.bytes
    )
      invalid();
    const receipt = await storeBackupExclusionReport({
      auth: authSnapshot,
      binding: captured.binding,
      limits: captured.read_limits,
      timeout_ms,
      chunks: file.createReadStream({ autoClose: false }),
    });
    if (receipt.inventory.excluded_files !== captured.excluded_files) invalid();
    await record(receipt);
    // Root retains the local report until its separately authorized retention
    // service releases it. Never grant the host arbitrary privileged unlink.
    return receipt;
  } finally {
    await file.close();
  }
}

/** Copy bounded metadata for an authenticated host's owning-bay RPC. */
export function validateBackupOutcomeReceipt(
  value: unknown,
  project_id: string,
): BackupOutcomeReceipt {
  const input = object(value);
  const evidence = object(input.producer);
  const binding = object(evidence.binding);
  if (binding.project_id !== project_id) invalid();
  const producer = parseBackupProducerEvidence(
    {
      ...evidence,
      schema_version: binding.schema_version,
      source: binding.source,
      report: binding.report,
      policy_sha256: binding.policy_sha256,
    },
    project_id,
    binding.backup_id,
  );
  if (
    typeof input.bucket !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket) ||
    input.object_key !== backupExclusionObjectKey(producer.binding) ||
    !uint(input.excluded_apparent_bytes) ||
    !Array.isArray(input.sample) ||
    input.sample.length !==
      Number(
        BigInt(producer.excluded_files) < 20n
          ? BigInt(producer.excluded_files)
          : 20n,
      ) ||
    BigInt(input.excluded_apparent_bytes) <
      BigInt(producer.excluded_files) *
        (BigInt(producer.exclude_larger_than_bytes) + 1n) ||
    (producer.excluded_files === "0" && input.excluded_apparent_bytes !== "0")
  )
    invalid();
  const seen = new Set<string>();
  let sampleBytes = 0n;
  const sample = input.sample.map((item) => {
    const row = object(item);
    if (
      typeof row.path_hex !== "string" ||
      !/^(?:[0-9a-f]{2}){1,4096}$/.test(row.path_hex) ||
      !uint(row.apparent_bytes) ||
      BigInt(row.apparent_bytes) <=
        BigInt(producer.exclude_larger_than_bytes) ||
      BigInt(row.apparent_bytes) > BigInt(input.excluded_apparent_bytes) ||
      (row.acknowledgement_key !== null &&
        (typeof row.acknowledgement_key !== "string" ||
          !DIGEST.test(row.acknowledgement_key))) ||
      seen.has(row.path_hex)
    )
      invalid();
    const bytes = Buffer.from(row.path_hex, "hex");
    const components = bytes.toString("latin1").split("/");
    if (
      bytes.includes(0) ||
      bytes[0] === 47 ||
      components.length > producer.read_limits.max_path_depth ||
      components.some((part) => !part || part === "." || part === "..")
    )
      invalid();
    seen.add(row.path_hex);
    sampleBytes += BigInt(row.apparent_bytes);
    if (sampleBytes > BigInt(input.excluded_apparent_bytes)) invalid();
    return {
      path_hex: row.path_hex,
      apparent_bytes: row.apparent_bytes,
      acknowledgement_key: row.acknowledgement_key,
    };
  });
  return {
    producer,
    bucket: input.bucket,
    object_key: input.object_key,
    excluded_apparent_bytes: input.excluded_apparent_bytes,
    sample,
  };
}
