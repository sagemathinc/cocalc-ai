import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import {
  allocateApiKeyIssuanceSequence,
  normalizeApiKeyIssuanceSequence,
} from "./issuance-sequence";

describe("API key sequence representation", () => {
  it("preserves values above the JavaScript safe integer limit", () => {
    for (const value of ["0", "9007199254740993", "9223372036854775807"])
      expect(normalizeApiKeyIssuanceSequence(value)).toBe(value);
  });
  it.each([
    undefined,
    null,
    0,
    1,
    -1,
    "",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e2",
    "9223372036854775808",
  ])("rejects a noncanonical or out-of-range value: %s", (value) =>
    expect(() => normalizeApiKeyIssuanceSequence(value)).toThrow(),
  );
});

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("account-home issuance ordering", () => {
  const pool = getPool();
  const owner = randomUUID();
  beforeAll(async () => {
    await pool.query(`CREATE TABLE accounts(
      account_id uuid PRIMARY KEY,home_bay_id text,deleted boolean,
      api_key_issuance_sequence bigint)`);
    await pool.query(
      `CREATE TABLE sequence_test_keys(key_id text PRIMARY KEY,issuance_sequence bigint)`,
    );
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM accounts");
    await pool.query("DELETE FROM sequence_test_keys");
    await pool.query("INSERT INTO accounts(account_id) VALUES($1)", [owner]);
  });
  async function issue(rollback = false) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sequence = await allocateApiKeyIssuanceSequence(client, owner);
      await client.query("INSERT INTO sequence_test_keys VALUES($1,$2)", [
        randomUUID(),
        sequence,
      ]);
      await client.query(rollback ? "ROLLBACK" : "COMMIT");
      return sequence;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  it("allocates a shared sequence atomically with key creation", async () => {
    expect(await issue()).toBe("1");
    expect(await issue()).toBe("2");
    expect(await issue(true)).toBe("3");
    expect(await issue()).toBe("3");
    expect(
      (
        await pool.query(
          "SELECT issuance_sequence::text AS value FROM sequence_test_keys ORDER BY issuance_sequence",
        )
      ).rows,
    ).toEqual([{ value: "1" }, { value: "2" }, { value: "3" }]);
  });
  it("continues an imported account counter without truncating BIGINT", async () => {
    await pool.query(
      "UPDATE accounts SET api_key_issuance_sequence=9007199254740992 WHERE account_id=$1",
      [owner],
    );
    expect(await issue()).toBe("9007199254740993");
  });
  it("fails closed at exhaustion or an invalid stored counter", async () => {
    for (const value of ["9223372036854775807", "-1"]) {
      await pool.query(
        "UPDATE accounts SET api_key_issuance_sequence=$2 WHERE account_id=$1",
        [owner, value],
      );
      await expect(issue()).rejects.toThrow("unavailable or exhausted");
    }
    expect((await pool.query("SELECT * FROM sequence_test_keys")).rows).toEqual(
      [],
    );
  });
  it("does not allocate for a deleted account", async () => {
    await pool.query("UPDATE accounts SET deleted=true WHERE account_id=$1", [
      owner,
    ]);
    await expect(issue()).rejects.toThrow("not found");
  });
});
