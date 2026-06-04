import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

import { decode as decodeConatPayload } from "@cocalc/conat/core/codec";

type PersistMessageRow = {
  seq: number;
  key?: string | null;
  time: number;
  headers?: string | null;
  compress: number;
  encoding: number;
  raw: Uint8Array;
  size: number;
  ttl?: number | null;
};

type DecodedPersistMessage = {
  type: "message";
  seq: number;
  key?: string | null;
  time: number;
  date: string;
  headers?: unknown;
  compress: number;
  encoding: number;
  raw_bytes: number;
  decoded_bytes: number;
  ttl?: number | null;
  value?: unknown;
  decode_error?: string;
};

export function parseNonNegativeInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return n;
}

export function parsePositiveInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

function parseJsonField(value: string | null | undefined): unknown {
  if (value == null || value === "") return undefined;
  return JSON.parse(value);
}

function decodePersistRaw(row: PersistMessageRow): Buffer {
  const raw = Buffer.from(row.raw);
  if (row.compress === 0) return raw;
  if (row.compress === 1) return Buffer.from(zstdDecompressSync(raw));
  throw new Error(`unknown compression algorithm ${row.compress}`);
}

function decodePersistMessage(row: PersistMessageRow): DecodedPersistMessage {
  const raw = decodePersistRaw(row);
  const base: DecodedPersistMessage = {
    type: "message",
    seq: row.seq,
    key: row.key,
    time: row.time,
    date: new Date(row.time * 1000).toISOString(),
    headers: parseJsonField(row.headers),
    compress: row.compress,
    encoding: row.encoding,
    raw_bytes: Buffer.from(row.raw).length,
    decoded_bytes: row.size,
    ttl: row.ttl,
  };
  try {
    base.value = decodeConatPayload({ encoding: row.encoding, data: raw });
  } catch (err) {
    base.decode_error = `${err}`;
  }
  return base;
}

function summarizeDecodedMessage(decoded: DecodedPersistMessage) {
  const value = decoded.value as any;
  return {
    type: decoded.type,
    seq: decoded.seq,
    time: decoded.time,
    date: decoded.date,
    key: decoded.key,
    compress: decoded.compress,
    encoding: decoded.encoding,
    raw_bytes: decoded.raw_bytes,
    decoded_bytes: decoded.decoded_bytes,
    is_snapshot: value?.is_snapshot === true,
    patch_time: typeof value?.time === "string" ? value.time : undefined,
    snapshot_bytes:
      typeof value?.snapshot === "string" ? value.snapshot.length : undefined,
    seq_info: value?.seq_info,
    headers: decoded.headers,
    decode_error: decoded.decode_error,
  };
}

function maybeSnapshotInfo(decoded: DecodedPersistMessage) {
  const value = decoded.value as any;
  if (value?.is_snapshot !== true) return undefined;
  return {
    db_seq: decoded.seq,
    time: decoded.time,
    date: decoded.date,
    patch_id: value.time,
    snapshot_bytes:
      typeof value.snapshot === "string" ? value.snapshot.length : undefined,
    seq_info: value.seq_info,
  };
}

export function decodeSyncDatabase({
  dbPath,
  jsonlOutput,
  includeValues = false,
  limit,
  fromSeq,
}: {
  dbPath: string;
  jsonlOutput?: string;
  includeValues?: boolean;
  limit?: number;
  fromSeq?: number;
}) {
  const filename = resolve(dbPath);
  if (!existsSync(filename)) {
    throw new Error(`database does not exist: ${filename}`);
  }
  const db = new DatabaseSync(filename, { readOnly: true });
  let outputFd: number | undefined;
  const writeJsonl = (obj: unknown) => {
    if (outputFd != null) {
      writeSync(outputFd, `${JSON.stringify(obj)}\n`);
    }
  };
  try {
    const full = db
      .prepare(
        "SELECT count(*) AS rows, min(seq) AS min_seq, max(seq) AS max_seq, sum(length(raw)) AS raw_bytes, sum(size) AS decoded_bytes FROM messages",
      )
      .get() as any;
    const compress = db
      .prepare(
        "SELECT compress, count(*) AS rows, sum(length(raw)) AS raw_bytes, sum(size) AS decoded_bytes FROM messages GROUP BY compress ORDER BY compress",
      )
      .all();
    const checkpoints = db
      .prepare(
        "SELECT name, seq, time, data_json, revision FROM stream_checkpoints ORDER BY name",
      )
      .all()
      .map((row: any) => ({
        name: row.name,
        seq: row.seq,
        time: row.time,
        data: parseJsonField(row.data_json),
        revision: row.revision,
      }));
    const metadata = db
      .prepare(
        "SELECT metadata_json, revision FROM stream_metadata WHERE id = 1",
      )
      .get() as any;
    const config = db
      .prepare("SELECT field, value FROM config ORDER BY field")
      .all();

    const snapshotRows: ReturnType<typeof maybeSnapshotInfo>[] = [];
    let decodedRows = 0;
    let decodeErrors = 0;
    let query =
      "SELECT seq, key, time, headers, compress, encoding, raw, size, ttl FROM messages";
    const params: any[] = [];
    if (fromSeq != null) {
      query += " WHERE seq >= ?";
      params.push(fromSeq);
    }
    query += " ORDER BY seq";
    if (limit != null) {
      query += " LIMIT ?";
      params.push(limit);
    }

    if (jsonlOutput != null) {
      outputFd = openSync(resolve(jsonlOutput), "w");
      writeJsonl({
        type: "database",
        path: filename,
        generated_at: new Date().toISOString(),
      });
      writeJsonl({ type: "config", rows: config });
      writeJsonl({
        type: "metadata",
        revision: metadata?.revision,
        value: parseJsonField(metadata?.metadata_json),
      });
      for (const checkpoint of checkpoints) {
        writeJsonl({ type: "checkpoint", ...checkpoint });
      }
    }

    for (const row of db.prepare(query).iterate(...params) as Iterable<any>) {
      const decoded = decodePersistMessage(row as PersistMessageRow);
      decodedRows += 1;
      if (decoded.decode_error != null) decodeErrors += 1;
      const snapshot = maybeSnapshotInfo(decoded);
      if (snapshot != null) snapshotRows.push(snapshot);
      writeJsonl(includeValues ? decoded : summarizeDecodedMessage(decoded));
    }

    const scanIsLimited = limit != null;
    const latestSnapshot = snapshotRows[snapshotRows.length - 1];
    const expectedLatestSnapshotCheckpoint =
      scanIsLimited || latestSnapshot?.seq_info?.seq == null
        ? undefined
        : {
            name: "latest_snapshot",
            seq: latestSnapshot.seq_info.seq,
            data: { patchId: latestSnapshot.patch_id },
          };
    let fromLatestSnapshot:
      | {
          rows: number;
          raw_bytes: number;
          decoded_bytes: number;
          min_seq?: number;
          max_seq?: number;
        }
      | undefined;
    if (expectedLatestSnapshotCheckpoint?.seq != null) {
      fromLatestSnapshot = db
        .prepare(
          "SELECT count(*) AS rows, min(seq) AS min_seq, max(seq) AS max_seq, sum(length(raw)) AS raw_bytes, sum(size) AS decoded_bytes FROM messages WHERE seq >= ?",
        )
        .get(expectedLatestSnapshotCheckpoint.seq) as any;
    }

    const summary = {
      path: filename,
      messages: {
        rows: full.rows,
        min_seq: full.min_seq,
        max_seq: full.max_seq,
        raw_bytes: full.raw_bytes ?? 0,
        decoded_bytes: full.decoded_bytes ?? 0,
        compression: compress,
      },
      decoded_scan: {
        rows: decodedRows,
        from_seq: fromSeq,
        limit,
        limited: scanIsLimited,
        decode_errors: decodeErrors,
      },
      metadata: {
        revision: metadata?.revision,
        value: parseJsonField(metadata?.metadata_json),
      },
      checkpoints,
      snapshots: {
        rows: snapshotRows.length,
        first: snapshotRows[0],
        latest: latestSnapshot,
        expected_latest_snapshot_checkpoint: expectedLatestSnapshotCheckpoint,
        from_latest_snapshot: fromLatestSnapshot,
      },
      jsonl_output:
        jsonlOutput == null
          ? undefined
          : {
              path: resolve(jsonlOutput),
              includes_values: includeValues,
            },
    };
    writeJsonl({ type: "summary", ...summary });
    return summary;
  } finally {
    if (outputFd != null) {
      closeSync(outputFd);
    }
    db.close();
  }
}
