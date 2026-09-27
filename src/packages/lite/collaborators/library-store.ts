/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import { validatePersonalLibraryTarget } from "@cocalc/util/personal-library";
import type { PersonalLibraryTarget } from "@cocalc/util/personal-library";

export type ClearArtifactAlias = (
  opts: PersonalLibraryTarget & { account_id: string },
) => Promise<void>;

/** Same semantics as server clearPersonalLibraryAlias; no new alias authority. */
export function liteArtifactAliasRemover(filename: string): ClearArtifactAlias {
  return async (opts) => {
    validatePersonalLibraryTarget(opts);
    // Do not create a second empty Library if main has not constructed it yet.
    const db = new DatabaseSync(realpathSync(filename));
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      const owner = db
        .prepare(
          "SELECT account_id,project_id FROM personal_library_owner WHERE singleton=1",
        )
        .get();
      if (
        !owner ||
        owner.account_id !== opts.account_id ||
        owner.project_id !== opts.project_id
      )
        throw Error("Personal library account or project unavailable");
      db.prepare(
        "UPDATE personal_library_aliases SET active=0 WHERE project_id=? AND entry_id=? AND active=1",
      ).run(opts.project_id, opts.entry_id);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  };
}
