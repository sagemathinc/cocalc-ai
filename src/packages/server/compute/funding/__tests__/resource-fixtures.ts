import getPool from "@cocalc/database/pool";

/** Remove only this suite's fictional liabilities from the persistent test DB.
 * Otherwise repeated runs eventually exhaust the real site exposure ceiling.
 */
export function fundingResourceFixtures() {
  const payers = new Set<string>();
  return {
    add(...ids: string[]) {
      for (const id of ids) payers.add(id);
    },
    async cleanup() {
      if (!payers.size) return;
      const db = await getPool().connect();
      try {
        const {
          rows: [identity],
        } = await db.query("SELECT current_database() AS name");
        if (
          identity.name !== "smc_ephemeral_testing_database" &&
          process.env.COCALC_TEST_USE_PGLITE !== "1"
        )
          throw Error(
            "Resource fixture cleanup requires the ephemeral test database",
          );
        await db.query("BEGIN");
        for (const table of [
          "compute_funding_purchase_attributions",
          "compute_funding_events",
          "compute_funding_reservations",
        ])
          await db.query(
            `DELETE FROM ${table} WHERE payer_account_id=ANY($1::uuid[])`,
            [[...payers]],
          );
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      } finally {
        db.release();
      }
    },
  };
}
