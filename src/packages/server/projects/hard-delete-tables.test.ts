/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { POSTGRES_TABLE_OWNERSHIP } from "@cocalc/util/db-schema";
import { PROJECT_HARD_DELETE_SIDE_TABLES } from "./hard-delete-tables";

const PROJECT_REHOME_PORTABLE_SQL_TABLES = new Set<string>();

describe("project hard-delete table ownership audit", () => {
  it("classifies every SQL side table that project hard-delete cleans up", () => {
    const missing = PROJECT_HARD_DELETE_SIDE_TABLES.filter(
      (table) => POSTGRES_TABLE_OWNERSHIP[table] == null,
    );

    expect(missing).toEqual([]);
  });

  it("does not mark project-owned hard-delete tables portable unless rehome copies them", () => {
    const unsafePortable = PROJECT_HARD_DELETE_SIDE_TABLES.filter((table) => {
      const entry = POSTGRES_TABLE_OWNERSHIP[table];
      return (
        entry?.ownership === "project-owning" &&
        entry.portability === "portable" &&
        !PROJECT_REHOME_PORTABLE_SQL_TABLES.has(table)
      );
    });

    expect(unsafePortable).toEqual([]);
  });

  it("documents seed-global tables still reached by local project hard-delete cleanup", () => {
    const seedGlobalTables = PROJECT_HARD_DELETE_SIDE_TABLES.filter(
      (table) => POSTGRES_TABLE_OWNERSHIP[table]?.ownership === "seed-global",
    ).sort();

    expect(seedGlobalTables).toEqual(["project_app_public_subdomains"]);
  });
});
