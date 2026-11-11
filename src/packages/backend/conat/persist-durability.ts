/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The durability records of disk-backed persist streams (finding 028), on
// tmpfs: see conat/persist/durability-records.
//
// root: COCALC_PERSIST_RUN_DIR, else /run/cocalc-persist.  It must be on
// tmpfs and writable only by the persist user (the host provisions it).

import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import {
  createDurabilityRecords,
  type DurabilityRecords,
} from "@cocalc/conat/persist/durability-records";

const logger = getLogger("persist:durability");

export const DEFAULT_PERSIST_RUN_DIR = "/run/cocalc-persist";

export function persistRunDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COCALC_PERSIST_RUN_DIR || DEFAULT_PERSIST_RUN_DIR;
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

// records in root, for a process generation (a new one by default)
export function nodeDurabilityRecords(
  root: string,
  generation = `${process.pid}-${randomUUID()}`,
): DurabilityRecords {
  return createDurabilityRecords({
    root,
    generation,
    fs: fs as any,
    sha256: sha256Hex,
    pid: process.pid,
    warn: (message, err) => logger.warn(message, { err: `${err}` }),
  });
}

let records: DurabilityRecords | undefined;

// the records of this process (one generation per process)
export function persistDurabilityRecords(): DurabilityRecords {
  records ??= nodeDurabilityRecords(persistRunDir());
  return records;
}
