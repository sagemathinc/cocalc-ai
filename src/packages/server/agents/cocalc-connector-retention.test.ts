import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { cleanupCocalcConnectorCredentials } from "./cocalc-connector-retention";

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("managed credential retention", () => {
  const pool = getPool();
  const owner = randomUUID();
  const other = randomUUID();
  beforeAll(async () => {
    await pool.query(
      "CREATE TABLE accounts(account_id uuid PRIMARY KEY,home_bay_id text)",
    );
    await pool.query("CREATE TABLE api_keys(account_id uuid,key_id text)");
    await pool.query(`CREATE TABLE agent_cocalc_connector_turns(
      turn_id uuid PRIMARY KEY,account_id uuid,key_id text,secret_ciphertext text,
      ended_at timestamptz,expires_at timestamptz)`);
    await pool.query("INSERT INTO accounts VALUES($1,'bay-1'),($2,'bay-2')", [
      owner,
      other,
    ]);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM api_keys");
    await pool.query("DELETE FROM agent_cocalc_connector_turns");
  });
  async function add({ age = 60000, ended = false, account = owner } = {}) {
    const id = randomUUID();
    const old = new Date(Date.now() - age);
    await pool.query("INSERT INTO api_keys VALUES($1,$2)", [account, id]);
    await pool.query(
      "INSERT INTO agent_cocalc_connector_turns VALUES($1,$2,$3,'encrypted-test-value',$4,$5)",
      [
        id,
        account,
        id,
        ended ? old : null,
        ended ? new Date(Date.now() + 60000) : old,
      ],
    );
    return id;
  }
  async function clean(batch = 5000) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await cleanupCocalcConnectorCredentials(client, batch);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  it("scrubs crashed and ended turns but retains active keys and unrelated manual keys", async () => {
    const expired = await add();
    const ended = await add({ ended: true });
    const active = await add({ age: -60000 });
    await pool.query("INSERT INTO api_keys VALUES($1,'manual')", [owner]);
    expect(await clean()).toEqual({
      connector_keys: 2,
      connector_secrets: 2,
      connector_history: 0,
    });
    const keys = (await pool.query("SELECT key_id FROM api_keys")).rows.map(
      (r) => r.key_id,
    );
    expect(keys.sort()).toEqual([active, "manual"].sort());
    const rows = (
      await pool.query(
        "SELECT * FROM agent_cocalc_connector_turns WHERE turn_id=ANY($1::uuid[])",
        [[expired, ended]],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.secret_ciphertext).toBe("");
      expect(row.ended_at).not.toBeNull();
    }
    expect(await clean()).toEqual({
      connector_keys: 0,
      connector_secrets: 0,
      connector_history: 0,
    });
  });
  it("preserves recent invalidation evidence and skips another account home", async () => {
    await add({ age: 5000, ended: true });
    await add({ age: 5000 });
    await add({ account: other });
    expect(await clean()).toEqual({
      connector_keys: 0,
      connector_secrets: 0,
      connector_history: 0,
    });
  });
  it("bounds each pass and retains secret-free history for thirty days", async () => {
    await add({ age: 31 * 86400000 });
    await add({ age: 29 * 86400000 });
    await add();
    expect(await clean(1)).toEqual({
      connector_keys: 1,
      connector_secrets: 1,
      connector_history: 1,
    });
    expect(await clean(1)).toEqual({
      connector_keys: 1,
      connector_secrets: 1,
      connector_history: 0,
    });
    expect(await clean(1)).toEqual({
      connector_keys: 1,
      connector_secrets: 1,
      connector_history: 0,
    });
  });
  it("rejects unbounded batch requests", async () => {
    await expect(clean(5001)).rejects.toThrow("invalid connector cleanup");
    await expect(clean(0)).rejects.toThrow("invalid connector cleanup");
  });
});
