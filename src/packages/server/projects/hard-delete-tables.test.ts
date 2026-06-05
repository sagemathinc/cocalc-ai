/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { POSTGRES_TABLE_OWNERSHIP } from "@cocalc/util/db-schema";
import {
  PROJECT_HARD_DELETE_PROJECT_ID_TABLES,
  PROJECT_HARD_DELETE_SEED_GLOBAL_TABLES,
  PROJECT_HARD_DELETE_SIDE_TABLES,
} from "./hard-delete-tables";
import {
  PROJECT_REHOME_PORTABLE_SQL_TABLES,
  PROJECT_REHOME_SQL_SIDE_TABLE_DECISIONS,
} from "./rehome-side-tables";

const PORTABLE_TABLES = new Set(PROJECT_REHOME_PORTABLE_SQL_TABLES);

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
        !PORTABLE_TABLES.has(table)
      );
    });

    expect(unsafePortable).toEqual([]);
  });

  it("has an explicit project rehome decision for every hard-delete side table", () => {
    const decisions = new Set(
      Object.keys(PROJECT_REHOME_SQL_SIDE_TABLE_DECISIONS),
    );
    const missing = PROJECT_HARD_DELETE_SIDE_TABLES.filter(
      (table) => !decisions.has(table),
    );
    const extras = [...decisions].filter(
      (table) => !PROJECT_HARD_DELETE_SIDE_TABLES.includes(table as any),
    );

    expect(missing).toEqual([]);
    expect(extras).toEqual([]);
  });

  it("keeps project rehome side-table decisions consistent with ownership", () => {
    const mismatches = Object.values(PROJECT_REHOME_SQL_SIDE_TABLE_DECISIONS)
      .map((decision) => {
        const entry = POSTGRES_TABLE_OWNERSHIP[decision.table];
        if (!entry) {
          return `${decision.table}: missing ownership`;
        }
        if (
          decision.status === "seed-global-cleanup" &&
          entry.ownership !== "seed-global"
        ) {
          return `${decision.table}: expected seed-global`;
        }
        if (
          decision.status === "projection" &&
          entry.ownership !== "projection"
        ) {
          return `${decision.table}: expected projection`;
        }
        if (
          decision.status === "audit-local" &&
          entry.ownership !== "audit-local"
        ) {
          return `${decision.table}: expected audit-local`;
        }
      })
      .filter(Boolean);

    expect(mismatches).toEqual([]);
  });

  it("keeps seed-global cleanup out of the local project-id delete list", () => {
    const seedGlobalTables = PROJECT_HARD_DELETE_PROJECT_ID_TABLES.filter(
      (table) => POSTGRES_TABLE_OWNERSHIP[table]?.ownership === "seed-global",
    ).sort();

    expect(seedGlobalTables).toEqual([]);
  });

  it("documents seed-global project-attached cleanup tables", () => {
    expect([...PROJECT_HARD_DELETE_SEED_GLOBAL_TABLES]).toEqual([
      "project_app_public_subdomains",
    ]);
  });
});
