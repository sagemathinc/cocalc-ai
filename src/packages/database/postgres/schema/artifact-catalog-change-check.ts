/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The change log's empty entry id means exactly a project-wide reset. The
// constraint is added NOT VALID (new rows are checked at once) and validated
// separately: an existing violator must never stop a bay from starting, and
// is never rewritten here. Account-wide deltas are served only once the
// constraint is validated (see artifactCatalogChangeCheckValidated).

import getLogger from "@cocalc/backend/logger";
import type { Client } from "@cocalc/database/pool";

type DatabaseClient = Pick<Client, "query">;

const log = getLogger("db:schema:artifact-catalog-change-check");

export const ARTIFACT_CATALOG_CHANGE_CHECK =
  "artifact_catalog_changes_op_entry_check";
const EXPRESSION = "((op = 'reset') = (entry_id = ''))";

async function state(
  db: DatabaseClient,
): Promise<{ table: boolean; exists: boolean; validated: boolean }> {
  const { rows } = await db.query(
    `SELECT to_regclass('artifact_catalog_changes') IS NOT NULL AS table,
       EXISTS (SELECT 1 FROM pg_constraint
         WHERE conname=$1 AND contype='c'
           AND conrelid=to_regclass('artifact_catalog_changes')) AS exists,
       COALESCE((SELECT convalidated FROM pg_constraint
         WHERE conname=$1 AND contype='c'
           AND conrelid=to_regclass('artifact_catalog_changes')), false) AS validated`,
    [ARTIFACT_CATALOG_CHANGE_CHECK],
  );
  return rows[0] ?? { table: false, exists: false, validated: false };
}

/** True once the constraint exists and every existing row satisfies it. */
export async function artifactCatalogChangeCheckValidated(
  db: DatabaseClient,
): Promise<boolean> {
  return (await state(db)).validated;
}

/**
 * Adds the constraint NOT VALID if missing, then tries to validate it. A
 * failed validation is logged and left for a later retry; it never throws.
 * Returns whether the constraint is validated.
 */
export async function ensureArtifactCatalogChangeCheck(
  db: DatabaseClient,
): Promise<boolean> {
  const current = await state(db);
  if (!current.table) return false;
  if (current.validated) return true;
  if (!current.exists) {
    await db.query(
      `ALTER TABLE artifact_catalog_changes
         ADD CONSTRAINT ${ARTIFACT_CATALOG_CHANGE_CHECK}
         CHECK ${EXPRESSION} NOT VALID`,
    );
  }
  try {
    await db.query(
      `ALTER TABLE artifact_catalog_changes
         VALIDATE CONSTRAINT ${ARTIFACT_CATALOG_CHANGE_CHECK}`,
    );
    return true;
  } catch (err) {
    // Existing violators need a reviewed repair; deltas stay unavailable.
    log.error("artifact catalog change check is not validated", {
      err: `${err}`,
    });
    return false;
  }
}

/** Schema sync is needed while the constraint is missing (not merely
 * unvalidated: validation is retried by catalog maintenance). */
export async function artifactCatalogChangeCheckNeedsSync(
  db: DatabaseClient,
): Promise<boolean> {
  const current = await state(db);
  return current.table && !current.exists;
}
