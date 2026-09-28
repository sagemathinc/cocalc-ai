import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import {
  admitAccountSearch,
  ensureSearchAdmissionSchema,
  nextSearchAdmission,
} from "./search-admission";

test("allows burst 30, then one admission per 200ms without charging denials", () => {
  const now = 1_790_000_000_000;
  let next: number | null = null;
  for (let i = 0; i < 30; i++) next = nextSearchAdmission(next, now);
  expect(next).toBe(now + 6000);
  expect(() => nextSearchAdmission(next, now)).toThrow("retry after 1 seconds");
  expect(nextSearchAdmission(next, now + 200)).toBe(now + 6200);
  expect(nextSearchAdmission(next, now + 60000)).toBe(now + 60200);
});

test("retains rate debt through clock rollback and rejects corrupt clocks", () => {
  expect(() => nextSearchAdmission(10000, 1000)).toThrow("rate exceeded");
  for (const invalid of ["bad", -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => nextSearchAdmission(invalid, 1000)).toThrow("invalid");
    expect(() => nextSearchAdmission(null, Number(invalid))).toThrow("invalid");
  }
});

test("key bucket permits burst 10 and refills one admission per second", () => {
  const now = 1_790_000_000_000;
  let next: number | null = null;
  for (let i = 0; i < 10; i++) next = nextSearchAdmission(next, now, true);
  expect(next).toBe(now + 10000);
  expect(() => nextSearchAdmission(next, now + 999, true)).toThrow(
    "key search rate exceeded",
  );
  expect(nextSearchAdmission(next, now + 1000, true)).toBe(now + 11000);
});

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("durable account-home search admission", () => {
  const pool = getPool();
  const account_id = randomUUID();
  beforeAll(async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS api_keys(account_id UUID, key_id TEXT, scope_revision INTEGER, expire TIMESTAMPTZ)",
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS accounts(account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await ensureSearchAdmissionSchema();
    await pool.query("INSERT INTO accounts(account_id) VALUES($1)", [
      account_id,
    ]);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM api_keys WHERE account_id=$1", [account_id]);
    await pool.query(
      "INSERT INTO api_keys(account_id,key_id,scope_revision) VALUES($1,'search-key-1',1),($1,'search-key-2',1)",
      [account_id],
    );
    await pool.query(
      "UPDATE accounts SET home_bay_id=NULL, api_search_next_ms=NULL WHERE account_id=$1",
      [account_id],
    );
  });
  afterAll(async () => {
    await pool.query("DELETE FROM api_keys WHERE account_id=$1", [account_id]);
    await pool.query("DELETE FROM accounts WHERE account_id=$1", [account_id]);
  });
  test("separate invocations share durable debt and denials leave it unchanged", async () => {
    await admitAccountSearch(account_id);
    const read = async () =>
      (
        await pool.query(
          "SELECT api_search_next_ms::text AS next FROM accounts WHERE account_id=$1",
          [account_id],
        )
      ).rows[0].next;
    expect(Number(await read())).toBeGreaterThan(0);
    await pool.query(
      "UPDATE accounts SET api_search_next_ms=floor(extract(epoch FROM clock_timestamp())*1000)+60000 WHERE account_id=$1",
      [account_id],
    );
    const previous = await read();
    await expect(admitAccountSearch(account_id)).rejects.toMatchObject({
      code: "api_search_rate_limited",
    });
    await expect(admitAccountSearch(account_id)).rejects.toMatchObject({
      code: "api_search_rate_limited",
    });
    expect(await read()).toBe(previous);
  });
  test("key rejection does not charge the account or a different key", async () => {
    await pool.query(
      "UPDATE api_keys SET api_search_next_ms=floor(extract(epoch FROM clock_timestamp())*1000)+60000 WHERE account_id=$1 AND key_id='search-key-1'",
      [account_id],
    );
    await expect(
      admitAccountSearch(account_id, {
        key_id: "search-key-1",
        scope_revision: 1,
      }),
    ).rejects.toThrow("key search rate exceeded");
    expect(
      (
        await pool.query(
          "SELECT api_search_next_ms FROM accounts WHERE account_id=$1",
          [account_id],
        )
      ).rows[0].api_search_next_ms,
    ).toBeNull();
    await expect(
      admitAccountSearch(account_id, {
        key_id: "search-key-2",
        scope_revision: 1,
      }),
    ).resolves.toBeUndefined();
  });
  test("account rejection cannot be bypassed by switching keys", async () => {
    await pool.query(
      "UPDATE accounts SET api_search_next_ms=floor(extract(epoch FROM clock_timestamp())*1000)+60000 WHERE account_id=$1",
      [account_id],
    );
    for (const key_id of ["search-key-1", "search-key-2"]) {
      await expect(
        admitAccountSearch(account_id, { key_id, scope_revision: 1 }),
      ).rejects.toThrow("account search rate exceeded");
    }
    expect(
      (
        await pool.query(
          "SELECT api_search_next_ms FROM api_keys WHERE account_id=$1",
          [account_id],
        )
      ).rows.every((row) => row.api_search_next_ms === null),
    ).toBe(true);
  });
  test("revoked, changed and expired keys are rejected without charging", async () => {
    await expect(
      admitAccountSearch(account_id, {
        key_id: "missing-key",
        scope_revision: 1,
      }),
    ).rejects.toThrow("unavailable or changed");
    await expect(
      admitAccountSearch(account_id, {
        key_id: "search-key-1",
        scope_revision: 2,
      }),
    ).rejects.toThrow("unavailable or changed");
    await pool.query(
      "UPDATE api_keys SET expire=clock_timestamp()-interval '1 second' WHERE account_id=$1",
      [account_id],
    );
    await expect(
      admitAccountSearch(account_id, {
        key_id: "search-key-1",
        scope_revision: 1,
      }),
    ).rejects.toThrow("unavailable or changed");
    expect(
      (
        await pool.query(
          "SELECT api_search_next_ms FROM accounts WHERE account_id=$1",
          [account_id],
        )
      ).rows[0].api_search_next_ms,
    ).toBeNull();
  });
  test("serializes concurrent admissions rather than overwriting one another", async () => {
    // Keep virtual time ahead of database wall time throughout these writes.
    await pool.query(
      "UPDATE accounts SET api_search_next_ms=floor(extract(epoch FROM clock_timestamp())*1000)+3000 WHERE account_id=$1",
      [account_id],
    );
    const before = Number(
      (
        await pool.query(
          "SELECT api_search_next_ms FROM accounts WHERE account_id=$1",
          [account_id],
        )
      ).rows[0].api_search_next_ms,
    );
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => admitAccountSearch(account_id)),
    );
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    expect(accepted).toBeGreaterThan(0);
    const after = Number(
      (
        await pool.query(
          "SELECT api_search_next_ms FROM accounts WHERE account_id=$1",
          [account_id],
        )
      ).rows[0].api_search_next_ms,
    );
    expect(after).toBe(before + accepted * 200);
  });
  test("rejects a foreign home without changing admission state", async () => {
    await pool.query(
      "UPDATE accounts SET home_bay_id='foreign-bay' WHERE account_id=$1",
      [account_id],
    );
    await expect(admitAccountSearch(account_id)).rejects.toThrow(
      "homed on foreign-bay",
    );
    expect(
      (
        await pool.query(
          "SELECT api_search_next_ms FROM accounts WHERE account_id=$1",
          [account_id],
        )
      ).rows[0].api_search_next_ms,
    ).toBeNull();
  });
});
