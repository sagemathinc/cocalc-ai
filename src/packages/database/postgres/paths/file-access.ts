/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { callback2 } from "@cocalc/util/async-utils";
import { expire_time, uuid } from "@cocalc/util/misc";
import type { PostgreSQL } from "../types";
import { pii_expire } from "../account/pii";

export interface LogFileAccessOptions {
  project_id: string;
  account_id: string;
  filename: string;
}

/**
 * Log file access to the file_access_log table.
 * This is throttled (60 seconds) to prevent duplicate entries from the same
 * project/account/filename combination within a minute.
 *
 * Note: Multiple servers may still create entries within the same minute.
 */
export async function log_file_access(
  db: PostgreSQL,
  opts: LogFileAccessOptions,
): Promise<void> {
  // Throttle: if called with same input within 60s, ignore
  if (
    db._throttle(
      "log_file_access",
      60,
      opts.project_id,
      opts.account_id,
      opts.filename,
    )
  ) {
    return;
  }

  // If no PII expiration is set, use 1 year as a fallback
  const expire = (await pii_expire()) ?? expire_time(365 * 24 * 60 * 60);

  await callback2(db._query.bind(db), {
    query: "INSERT INTO file_access_log",
    values: {
      "id         :: UUID     ": uuid(),
      "project_id :: UUID     ": opts.project_id,
      "account_id :: UUID     ": opts.account_id,
      "filename   :: TEXT     ": opts.filename,
      "time       :: TIMESTAMP": "NOW()",
      "expire     :: TIMESTAMP": expire,
    },
  });
}

export interface GetFileAccessOptions {
  start?: Date;
  end?: Date;
  project_id?: string;
  account_id?: string;
  filename?: string;
}

export interface FileAccessEntry {
  project_id: string;
  account_id: string;
  filename: string;
  time: Date;
}

/**
 * Get all file access times subject to various constraints.
 * This allows efficient querying and slicing of file access history.
 *
 * Note: This was not available in the RethinkDB version but is now
 * easily queryable with PostgreSQL.
 */
export async function get_file_access(
  db: PostgreSQL,
  opts: GetFileAccessOptions,
): Promise<FileAccessEntry[]> {
  const { rows } = await callback2(db._query.bind(db), {
    query: "SELECT project_id, account_id, filename, time FROM file_access_log",
    where: {
      "time >= $::TIMESTAMP": opts.start,
      "time <= $::TIMESTAMP": opts.end,
      "project_id = $::UUID": opts.project_id,
      "account_id = $::UUID": opts.account_id,
      "filename   = $::TEXT": opts.filename,
    },
  });

  return rows;
}
