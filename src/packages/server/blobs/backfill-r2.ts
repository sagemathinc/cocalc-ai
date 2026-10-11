/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { db } from "@cocalc/database";
import getPool from "@cocalc/database/pool";
import { callback2 } from "@cocalc/util/async-utils";
import { isValidUUID } from "@cocalc/util/misc";

import { detectRasterImage } from "./media";
import { putImageBlobToR2 } from "./store";

export interface BackfillR2Options {
  batchSize?: number;
  dryRun?: boolean;
  includeExpired?: boolean;
  limit?: number;
  startAfter?: string;
}

export interface BackfillR2Summary {
  scanned: number;
  raster: number;
  skippedNonRaster: number;
  missingBytes: number;
  created: number;
  alreadyExists: number;
  failed: number;
  lastUuid?: string;
}

function positiveInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function nextUuidBatch({
  batchSize,
  includeExpired,
  lastUuid,
}: {
  batchSize: number;
  includeExpired: boolean;
  lastUuid?: string;
}): Promise<string[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!includeExpired) {
    clauses.push("(expire IS NULL OR expire > NOW())");
  }
  if (lastUuid) {
    params.push(lastUuid);
    clauses.push(`id > $${params.length}::uuid`);
  }
  params.push(batchSize);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await getPool().query<{ uuid: string }>(
    `
      SELECT id::text AS uuid
        FROM blobs
       ${where}
       ORDER BY id
       LIMIT $${params.length}
    `,
    params,
  );
  return rows.map((row) => row.uuid);
}

async function readPostgresBlob(uuid: string): Promise<Buffer | undefined> {
  const blob = await callback2(db().get_blob, { uuid, touch: false });
  if (blob == null) return undefined;
  return Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
}

export async function backfillPostgresBlobsToR2({
  batchSize = 100,
  dryRun = false,
  includeExpired = false,
  limit,
  startAfter,
}: BackfillR2Options = {}): Promise<BackfillR2Summary> {
  if (startAfter && !isValidUUID(startAfter)) {
    throw new Error("startAfter must be a valid blob UUID");
  }
  const summary: BackfillR2Summary = {
    scanned: 0,
    raster: 0,
    skippedNonRaster: 0,
    missingBytes: 0,
    created: 0,
    alreadyExists: 0,
    failed: 0,
    lastUuid: startAfter,
  };
  const normalizedBatchSize = Math.min(positiveInteger(batchSize, 100), 1000);
  const maximum = limit == null ? Infinity : positiveInteger(limit, 0);

  while (summary.scanned < maximum) {
    const uuids = await nextUuidBatch({
      batchSize: Math.min(normalizedBatchSize, maximum - summary.scanned),
      includeExpired,
      lastUuid: summary.lastUuid,
    });
    if (uuids.length === 0) break;
    for (const uuid of uuids) {
      summary.lastUuid = uuid;
      summary.scanned += 1;
      const blob = await readPostgresBlob(uuid);
      if (!blob) {
        summary.missingBytes += 1;
        continue;
      }
      const media = detectRasterImage(blob);
      if (!media) {
        summary.skippedNonRaster += 1;
        continue;
      }
      summary.raster += 1;
      if (dryRun) continue;
      try {
        const result = await putImageBlobToR2({
          uuid,
          blob,
          media,
          source: "current-backfill",
        });
        if (result === "created") {
          summary.created += 1;
        } else {
          summary.alreadyExists += 1;
        }
      } catch (err) {
        summary.failed += 1;
        throw new Error(`failed to backfill blob ${uuid}: ${err}`);
      }
      if (summary.scanned >= maximum) break;
    }
  }

  if (!summary.lastUuid) {
    delete summary.lastUuid;
  }
  return summary;
}

function usage(): string {
  return [
    "Usage: node packages/server/dist/blobs/backfill-r2.js [options]",
    "",
    "Options:",
    "  --batch-size <n>    Number of blobs to scan per database batch, max 1000",
    "  --limit <n>         Stop after scanning this many rows",
    "  --start-after <id>  Resume after this blob UUID",
    "  --include-expired   Include expired blob rows",
    "  --dry-run           Validate and count rows without writing R2 objects",
    "  --help              Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): BackfillR2Options & { help?: boolean } {
  const options: BackfillR2Options & { help?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--include-expired") {
      options.includeExpired = true;
    } else if (arg === "--batch-size") {
      options.batchSize = positiveInteger(argv[++i], 100);
    } else if (arg === "--limit") {
      options.limit = positiveInteger(argv[++i], 0);
    } else if (arg === "--start-after") {
      options.startAfter = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const summary = await backfillPostgresBlobsToR2(options);
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
