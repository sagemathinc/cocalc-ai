/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import type { BackupCoverageReportChunk } from "@cocalc/util/types/backup-coverage";

// Keep client memory bounded too. Larger reports require a streaming download
// implementation; do not accumulate arbitrary server-directed blobs in a tab.
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export async function downloadCoverageReport(
  backup_id: string,
  load: (offset: number) => Promise<BackupCoverageReportChunk>,
  signal: AbortSignal,
): Promise<Blob> {
  let offset = 0;
  let expected: { bytes: number; sha256: string } | undefined;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  while (true) {
    signal.throwIfAborted();
    const chunk = await load(offset);
    signal.throwIfAborted();
    if (
      chunk.backup_id !== backup_id ||
      !Number.isSafeInteger(chunk.bytes) ||
      chunk.bytes <= 0 ||
      chunk.bytes > MAX_DOWNLOAD_BYTES ||
      typeof chunk.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(chunk.sha256) ||
      typeof chunk.data_base64 !== "string" ||
      chunk.data_base64.length > 87384
    )
      throw new Error("Invalid or oversized backup report download");
    if (!expected) expected = { bytes: chunk.bytes, sha256: chunk.sha256 };
    if (expected.bytes !== chunk.bytes || expected.sha256 !== chunk.sha256)
      throw new Error("Backup report changed during download");
    const data = Uint8Array.from(atob(chunk.data_base64), (character) =>
      character.charCodeAt(0),
    );
    if (
      !data.length ||
      data.length > 65536 ||
      data.length > expected.bytes - offset
    )
      throw new Error("Invalid backup report chunk");
    offset += data.length;
    chunks.push(data);
    if (chunk.next_offset === null) {
      if (offset !== expected.bytes)
        throw new Error("Incomplete backup report download");
      break;
    }
    if (chunk.next_offset !== offset || offset >= expected.bytes)
      throw new Error("Invalid backup report continuation");
  }
  const blob = new Blob(chunks, { type: "application/x-ndjson" });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  signal.throwIfAborted();
  if (
    Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("") !== expected!.sha256
  )
    throw new Error("Backup report integrity verification failed");
  return blob;
}
