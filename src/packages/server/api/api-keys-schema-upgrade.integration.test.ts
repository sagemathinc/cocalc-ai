/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Older api_keys tables are upgraded by the schema synchronization, which
// request paths used to do with ALTER TABLE (see schema-columns.ts).

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { assertSchemaColumns } from "./schema-columns";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("api_keys schema upgrade by the schema synchronization", () => {
  const pool = () => getPool();

  beforeEach(async () => {
    await pool().query("DROP TABLE IF EXISTS api_keys");
    await pool().query(
      "CREATE TABLE api_keys(id INTEGER PRIMARY KEY, account_id UUID, hash TEXT, expire TIMESTAMPTZ)",
    );
  });

  it.each(["pre-scope", "nullable-revision"])(
    "upgrades %s rows without changing stored credentials or grants",
    async (version) => {
      const owner = randomUUID();
      const project = randomUUID();
      await pool().query(
        "INSERT INTO api_keys VALUES(1,$1,'synthetic-hash',NULL),(2,$1,'second-hash',now()+interval '1 day')",
        [owner],
      );
      const before = (
        await pool().query(
          "SELECT id,account_id,hash,expire FROM api_keys ORDER BY id",
        )
      ).rows;
      if (version === "nullable-revision") {
        await pool().query(
          "ALTER TABLE api_keys ADD COLUMN scope_revision INTEGER, ADD COLUMN capabilities TEXT[] NOT NULL DEFAULT '{}', ADD COLUMN allowed_project_ids UUID[] NOT NULL DEFAULT '{}', ADD COLUMN scope JSONB",
        );
        await pool().query(
          "UPDATE api_keys SET capabilities=ARRAY['file:read'],allowed_project_ids=ARRAY[$1::UUID] WHERE id=1",
          [project],
        );
        await pool().query(
          "UPDATE api_keys SET scope_revision=7,scope=$1::JSONB WHERE id=2",
          [
            JSON.stringify({
              version: 1,
              account: ["project:list"],
              projects: [],
            }),
          ],
        );
      }
      await syncSchema({ api_keys: SCHEMA.api_keys });
      await assertSchemaColumns("api_keys", [
        "issuance_sequence",
        "api_search_next_ms",
        "key_id",
        "capabilities",
        "allowed_project_ids",
        "scope",
        "scope_revision",
      ]);
      expect(
        (
          await pool().query(
            "SELECT id,account_id,hash,expire FROM api_keys ORDER BY id",
          )
        ).rows,
      ).toEqual(before);
      const rows = (await pool().query("SELECT * FROM api_keys ORDER BY id"))
        .rows;
      expect(rows.map((row) => row.scope_revision)).toEqual(
        version === "nullable-revision" ? [1, 7] : [1, 1],
      );
      expect(rows[0].capabilities).toEqual(
        version === "nullable-revision" ? ["file:read"] : [],
      );
      expect(rows[0].allowed_project_ids).toEqual(
        version === "nullable-revision" ? [project] : [],
      );
      expect(rows[0].scope).toBeNull();
      await pool().query(
        "INSERT INTO api_keys(id,account_id,hash) VALUES(3,$1,'new-hash')",
        [owner],
      );
      const inserted = (
        await pool().query(
          "SELECT scope_revision, capabilities, allowed_project_ids FROM api_keys WHERE id=3",
        )
      ).rows[0];
      expect(inserted).toEqual({
        scope_revision: 1,
        capabilities: [],
        allowed_project_ids: [],
      });
      await expect(
        pool().query("UPDATE api_keys SET scope_revision=NULL WHERE id=1"),
      ).rejects.toMatchObject({ code: "23502" });
      const { rows: indexes } = await pool().query(
        "SELECT indexdef FROM pg_indexes WHERE tablename='api_keys'",
      );
      const defs = indexes.map(({ indexdef }) => indexdef).join("\n");
      expect(defs).toMatch(/USING gin \(capabilities\)/);
      expect(defs).toMatch(/USING gin \(allowed_project_ids\)/);
      expect(defs).toMatch(/UNIQUE INDEX .* \(key_id\)/);
      // A second synchronization changes nothing.
      await syncSchema({ api_keys: SCHEMA.api_keys });
      expect(
        (await pool().query("SELECT * FROM api_keys WHERE id<3 ORDER BY id"))
          .rows,
      ).toEqual(rows);
    },
  );
});
