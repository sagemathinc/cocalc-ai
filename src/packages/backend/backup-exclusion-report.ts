/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export interface BackupExclusionSample {
  path_hex: string;
  apparent_bytes: string;
  // Presentation identity only. Never authorizes omission or source deletion.
  acknowledgement_key: string | null;
}

export interface VerifiedBackupExclusionInventory {
  sha256: string;
  bytes: number;
  excluded_files: string;
  excluded_apparent_bytes: string;
  retained: Record<string, string>;
  sample: BackupExclusionSample[];
}

const U64_MAX = (1n << 64n) - 1n;
const digestPattern = /^[0-9a-f]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(): never {
  // Never put private filenames or untrusted report text in operator logs.
  throw new Error("Invalid or incomplete backup exclusion evidence");
}

function object(value: unknown): Record<string, any> {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    invalid();
  return value as Record<string, any>;
}

function uint(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    invalid();
  const result = BigInt(value);
  if (result > U64_MAX) invalid();
  return result;
}

function timestamp(value: unknown): boolean {
  // Rustic jiff timestamps are signed nanosecond decimal strings.
  return typeof value === "string" && /^(0|-?[1-9][0-9]{0,28})$/.test(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value != null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function backupReportHeaderSha256(header: unknown): string {
  return createHash("sha256")
    .update(canonical(object(header)))
    .digest("hex");
}

// Source is always the single captured project root ("."). Keep raw bytes;
// replacement-character UTF-8 decoding would alias distinct Linux filenames.
function relativePathHex(value: unknown, maxDepth: bigint): string {
  const path = object(value);
  if (
    path.encoding !== "unix-bytes-hex" ||
    typeof path.value !== "string" ||
    !/^(?:[0-9a-f]{2}){1,4096}$/.test(path.value)
  )
    invalid();
  let bytes = Buffer.from(path.value, "hex");
  if (bytes[0] === 46 && bytes[1] === 47) bytes = bytes.subarray(2);
  if (!bytes.length || bytes.includes(0) || bytes[0] === 47) invalid();
  let start = 0;
  let depth = 0n;
  for (let i = 0; i <= bytes.length; i++) {
    if (i !== bytes.length && bytes[i] !== 47) continue;
    const part = bytes.subarray(start, i);
    if (
      !part.length ||
      part.equals(Buffer.from(".")) ||
      part.equals(Buffer.from(".."))
    )
      invalid();
    if (++depth > maxDepth) invalid();
    start = i + 1;
  }
  return bytes.toString("hex");
}

/**
 * Verify a protected Rustic v1 report without accumulating its full path list.
 * Expected digests MUST come from trusted backup metadata, not the downloaded
 * report itself. This validates inventory, not backup success, source freshness,
 * selection authorization, or restore capacity. No callbacks expose a prefix as
 * complete evidence; callers receive a result only after EOF and hash checks.
 */
export async function verifyBackupExclusionReport({
  chunks,
  sha256,
  header_sha256,
  policy_sha256,
  max_bytes,
  max_record_bytes,
  max_entries,
  max_path_depth,
  sample_limit = 20,
}: {
  chunks: AsyncIterable<Uint8Array>;
  sha256: string;
  header_sha256: string;
  policy_sha256: string;
  max_bytes: number;
  max_record_bytes: number;
  max_entries: number;
  max_path_depth: number;
  sample_limit?: number;
}): Promise<VerifiedBackupExclusionInventory> {
  for (const digest of [sha256, header_sha256, policy_sha256]) {
    if (!digestPattern.test(digest)) invalid();
  }
  for (const bound of [
    max_bytes,
    max_record_bytes,
    max_entries,
    max_path_depth,
  ]) {
    if (!Number.isSafeInteger(bound) || bound <= 0) invalid();
  }
  if (
    !Number.isSafeInteger(sample_limit) ||
    sample_limit < 0 ||
    sample_limit > 100 ||
    max_record_bytes > max_bytes
  )
    invalid();
  const hash = createHash("sha256");
  let bytes = 0;
  // Fixed record storage avoids quadratic concatenation for one-byte chunks.
  const pending = Buffer.allocUnsafe(max_record_bytes);
  let pendingBytes = 0;
  let header: Record<string, any> | undefined;
  let footer: Record<string, any> | undefined;
  let excluded = 0n;
  let apparent = 0n;
  const sample: BackupExclusionSample[] = [];

  const record = (line: Buffer) => {
    if (!line.length || line.length > max_record_bytes || footer) invalid();
    let value: Record<string, any>;
    try {
      value = object(JSON.parse(decoder.decode(line)));
    } catch {
      invalid();
    }
    if (value.schema_version !== 1) invalid();
    if (!header) {
      if (
        value.type !== "header" ||
        backupReportHeaderSha256(value) !== header_sha256
      )
        invalid();
      if (
        canonical(value.sources) !==
        canonical([{ encoding: "unix-bytes-hex", value: "2e" }])
      )
        invalid();
      if (
        !uint(value.exclude_larger_than_bytes) ||
        uint(value.max_report_bytes) > BigInt(max_bytes)
      )
        invalid();
      header = value;
      return;
    }
    if (value.type === "complete") {
      footer = object(value.inventory);
      return;
    }
    if (value.type !== "excluded" || value.reason !== "apparent_size")
      invalid();
    const size = uint(value.apparent_bytes);
    if (size <= uint(header.exclude_larger_than_bytes)) invalid();
    if (++excluded > BigInt(max_entries)) invalid();
    apparent += size;
    if (apparent > U64_MAX) invalid();
    const path_hex = relativePathHex(value.path, BigInt(max_path_depth));
    const version = object(value.file_version);
    uint(version.inode);
    for (const name of ["mtime_ns", "ctime_ns"]) {
      if (version[name] != null && !timestamp(version[name])) invalid();
    }
    for (const name of ["mode", "uid", "gid"]) {
      if (
        version[name] != null &&
        (!Number.isSafeInteger(version[name]) ||
          version[name] < 0 ||
          version[name] > 0xffffffff)
      )
        invalid();
    }
    if (sample.length < sample_limit) {
      const reliable =
        [null, undefined, "yes"].includes(
          object(header.save_options)["set-ctime"],
        ) &&
        uint(version.inode) > 0n &&
        timestamp(version.mtime_ns) &&
        timestamp(version.ctime_ns) &&
        ["mode", "uid", "gid"].every((name) => version[name] != null);
      const acknowledgement_key = reliable
        ? createHash("sha256")
            .update(
              canonical({
                version: 1,
                policy_sha256,
                path_hex,
                apparent_bytes: size.toString(),
                file_version: version,
              }),
            )
            .digest("hex")
        : null;
      sample.push({
        path_hex,
        apparent_bytes: size.toString(),
        acknowledgement_key,
      });
    }
  };

  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > max_bytes - bytes)
      invalid();
    bytes += chunk.byteLength;
    // Hash and parse the same owned bytes, even if a producer reuses its buffer.
    const data = Buffer.from(chunk);
    hash.update(data);
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(10, offset);
      const end = newline === -1 ? data.length : newline;
      const fragment = data.subarray(offset, end);
      if (fragment.length > max_record_bytes - pendingBytes) invalid();
      fragment.copy(pending, pendingBytes);
      pendingBytes += fragment.length;
      if (newline === -1) break;
      record(pending.subarray(0, pendingBytes));
      pendingBytes = 0;
      offset = newline + 1;
    }
  }
  if (pendingBytes || !header || !footer || hash.digest("hex") !== sha256)
    invalid();
  if (
    uint(footer.excluded_files) !== excluded ||
    uint(footer.excluded_apparent_bytes) !== apparent
  )
    invalid();
  if (bytes > Number(uint(header.max_report_bytes))) invalid();
  const retained = object(footer.retained);
  const retainedFields = [
    "entries",
    "files",
    "apparent_bytes",
    "chunk_references_bound",
    "content_reference_bytes_bound",
    "node_metadata_bytes",
    "max_path_depth",
  ];
  const result: Record<string, string> = {};
  for (const key of retainedFields)
    result[key] = uint(retained[key]).toString();
  if (
    uint(footer.inspected_entries) > BigInt(max_entries) ||
    uint(footer.inspected_entries) !== uint(retained.entries) + excluded ||
    uint(retained.files) > uint(retained.entries) ||
    uint(retained.content_reference_bytes_bound) !==
      uint(retained.chunk_references_bound) * 67n ||
    uint(footer.inspected_max_path_depth) > BigInt(max_path_depth) ||
    uint(retained.max_path_depth) > uint(footer.inspected_max_path_depth) ||
    uint(retained.node_metadata_bytes) >
      uint(footer.inspected_node_metadata_bytes)
  )
    invalid();
  return {
    sha256,
    bytes,
    excluded_files: excluded.toString(),
    excluded_apparent_bytes: apparent.toString(),
    retained: result,
    sample,
  };
}
