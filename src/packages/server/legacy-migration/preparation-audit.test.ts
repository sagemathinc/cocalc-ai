import { preservePreparationAuditSql } from "./preparation-audit";

const describePglite =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describePglite(
  "preserving preparation audit across restore replacement",
  () => {
    const originalDb = process.env.COCALC_DB;
    const originalDir = process.env.COCALC_PGLITE_DATA_DIR;
    let pool: ReturnType<(typeof import("@cocalc/database/pool"))["default"]>;
    beforeAll(async () => {
      process.env.COCALC_DB = "pglite";
      process.env.COCALC_PGLITE_DATA_DIR = "memory://";
      pool = (await import("@cocalc/database/pool")).default();
    });
    afterAll(async () => {
      await (await import("@cocalc/database/pglite")).closePglite();
      if (originalDb == null) delete process.env.COCALC_DB;
      else process.env.COCALC_DB = originalDb;
      if (originalDir == null) delete process.env.COCALC_PGLITE_DATA_DIR;
      else process.env.COCALC_PGLITE_DATA_DIR = originalDir;
    });

    it.each([null, { restored: true }])(
      "retains events but not stale snapshot state (%j)",
      async (next) => {
        const events = [{ reason: "support inspection", actor: "admin" }];
        const previous = {
          final_archive_remediation: {
            prepare_events: events,
            prepared: true,
            snapshot_id: "obsolete",
          },
        };
        const { rows } = await pool.query(
          `SELECT ${preservePreparationAuditSql("old_result", "$2::jsonb")} AS result
       FROM (SELECT $1::jsonb AS old_result) prior`,
          [
            JSON.stringify(previous),
            next == null ? null : JSON.stringify(next),
          ],
        );
        expect(rows[0].result).toEqual({
          ...next,
          final_archive_remediation: { prepare_events: events },
        });
      },
    );

    it("does not retain other legacy restore state", async () => {
      const { rows } = await pool.query(
        `SELECT ${preservePreparationAuditSql("$1::jsonb", "NULL::jsonb")} AS result`,
        [JSON.stringify({ restored: true })],
      );
      expect(rows[0].result).toBeNull();
    });
  },
);
