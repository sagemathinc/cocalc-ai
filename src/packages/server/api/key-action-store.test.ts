import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { ApiKeyActionStore } from "./key-action-store";
import type { ApiKeyActionReview } from "@cocalc/util/api-key-management";
import { MAX_PENDING_API_KEY_ACTIONS } from "@cocalc/util/api-key-management";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("API key action transactional storage", () => {
  const account_id = randomUUID();
  const pool = getPool();
  const store = new ApiKeyActionStore(pool);
  const authorize = jest.fn(async () => {});
  const execute = jest.fn(async (client, review) => {
    await client.query(
      "DELETE FROM api_key_action_test_targets WHERE key_id=$1",
      [review.binding.target_key_id],
    );
  });
  const review = (): ApiKeyActionReview => ({
    request_id: randomUUID(),
    action: { kind: "revoke_api_key", target_key_id: "target-key-id" },
    binding: {
      account_id,
      requesting_key_id: "requester-key-id",
      requesting_scope_revision: 2,
      target_key_id: "target-key-id",
      target_scope_revision: 3,
    },
    target_name: "CLI test",
    target_trunc: "masked",
    created_at: Date.now(),
    expires_at: Date.now() + 60000,
    status: "pending",
  });

  beforeAll(async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS accounts(account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await pool.query("INSERT INTO accounts(account_id) VALUES($1)", [
      account_id,
    ]);
    await pool.query(
      "CREATE TABLE api_key_action_test_targets(key_id TEXT PRIMARY KEY)",
    );
    await store.ensureSchema();
  });
  beforeEach(async () => {
    authorize.mockReset().mockResolvedValue(undefined);
    execute.mockClear();
    await pool.query(
      "DELETE FROM api_key_action_requests WHERE account_id=$1",
      [account_id],
    );
    await pool.query("DELETE FROM api_key_action_test_targets");
    await pool.query(
      "INSERT INTO api_key_action_test_targets VALUES('target-key-id')",
    );
  });
  afterAll(async () => {
    await pool.query(
      "DELETE FROM api_key_action_requests WHERE account_id=$1",
      [account_id],
    );
    await pool.query("DELETE FROM accounts WHERE account_id=$1", [account_id]);
    await pool.query("DROP TABLE api_key_action_test_targets");
  });

  it("keeps retries idempotent without renewing the approval lifetime", async () => {
    const input = review();
    const saved = await store.create(input, authorize);
    expect(
      await store.create(
        { ...input, expires_at: input.expires_at + 1000 },
        authorize,
      ),
    ).toEqual(saved);
    await expect(
      store.create(
        {
          ...input,
          binding: { ...input.binding, requesting_scope_revision: 4 },
        },
        authorize,
      ),
    ).rejects.toThrow("already used");
    expect(
      (
        await pool.query(
          "SELECT count(*)::INTEGER AS count FROM api_key_action_requests",
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("consumes a decision once and persists its mutation atomically", async () => {
    const saved = await store.create(review(), authorize);
    const options = {
      reviewed: saved,
      decision: "execute" as const,
      authorize,
      execute,
    };
    expect((await store.decide(options)).status).toBe("executed");
    expect((await store.decide(options)).status).toBe("executed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT * FROM api_key_action_test_targets")).rows,
    ).toHaveLength(0);
    await expect(
      store.decide({ ...options, decision: "reject" }),
    ).rejects.toThrow("already decided");
  });

  it("rolls back mutation and decision together when execution fails", async () => {
    const saved = await store.create(review(), authorize);
    await expect(
      store.decide({
        reviewed: saved,
        decision: "execute",
        authorize,
        execute: async (client, item) => {
          await execute(client, item);
          throw new Error("injected failure");
        },
      }),
    ).rejects.toThrow("injected failure");
    expect(
      (await pool.query("SELECT * FROM api_key_action_test_targets")).rows,
    ).toHaveLength(1);
    expect(
      (await pool.query("SELECT status FROM api_key_action_requests")).rows[0]
        .status,
    ).toBe("pending");
  });

  it("rejects changed reviews and failed current authorization before mutation", async () => {
    const saved = await store.create(review(), authorize);
    for (const changed of [
      { ...saved, target_name: "different" },
      { ...saved, expires_at: saved.expires_at + 1 },
      { ...saved, binding: { ...saved.binding, target_scope_revision: 4 } },
    ]) {
      await expect(
        store.decide({
          reviewed: changed,
          decision: "execute",
          authorize,
          execute,
        }),
      ).rejects.toThrow("review changed");
    }
    authorize.mockRejectedValue(
      new Error("requester revoked or fresh auth missing"),
    );
    await expect(
      store.decide({
        reviewed: saved,
        decision: "execute",
        authorize,
        execute,
      }),
    ).rejects.toThrow("requester revoked");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses expired approvals and records rejection without executing", async () => {
    const expired = review();
    expired.created_at = Date.now() - 10000;
    expired.expires_at = Date.now() - 1000;
    await expect(store.create(expired, authorize)).rejects.toThrow("expired");
    const saved = await store.create(review(), authorize);
    expect(
      (
        await store.decide({
          reviewed: saved,
          decision: "reject",
          authorize,
          execute,
        })
      ).status,
    ).toBe("rejected");
    await expect(
      store.decide({
        reviewed: saved,
        decision: "execute",
        authorize,
        execute,
      }),
    ).rejects.toThrow("already decided");
    expect(execute).not.toHaveBeenCalled();
  });

  it("bounds pending requests per account", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: MAX_PENDING_API_KEY_ACTIONS + 1 }, () =>
        store.create(review(), authorize),
      ),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      MAX_PENDING_API_KEY_ACTIONS,
    );
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason.message).toContain("too many pending");
    expect(
      (
        await pool.query(
          "SELECT count(*)::INTEGER AS count FROM api_key_action_requests",
        )
      ).rows[0].count,
    ).toBe(MAX_PENDING_API_KEY_ACTIONS);
  });

  it("rolls back an execution whose approval expires before commit", async () => {
    const input = review();
    input.expires_at = Date.now() + 1000;
    const saved = await store.create(input, authorize);
    await expect(
      store.decide({
        reviewed: saved,
        decision: "execute",
        authorize,
        execute: async (client, item) => {
          await execute(client, item);
          await new Promise((resolve) => setTimeout(resolve, 1100));
        },
      }),
    ).rejects.toThrow("expired");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT * FROM api_key_action_test_targets")).rows,
    ).toHaveLength(1);
    expect(
      (await pool.query("SELECT status FROM api_key_action_requests")).rows[0]
        .status,
    ).toBe("pending");
  });
});
