import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import {
  requestApiKeyActionLocal,
  decideApiKeyActionLocal,
  listApiKeyActionsLocal,
} from "./key-actions";
import type { ApiKeyPrincipal } from "./api-key-scope";

const homeMock = jest.fn();
const freshMock = jest.fn();
const tombstoneMock = jest.fn();
const bannedMock = jest.fn();
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args) => homeMock(...args),
  deleteClusterAccountApiKeyDirectoryEntry: (...args) => tombstoneMock(...args),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args) => freshMock(...args),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: (...args) => bannedMock(...args),
}));
jest.mock("./manage", () => ({ ensureApiKeysV2Schema: async () => {} }));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("manual-key revocation action authority", () => {
  const pool = getPool();
  const account_id = randomUUID();
  const scope = {
    version: 1,
    account: ["api-key:revoke:request"],
    projects: [],
  };
  const principal: ApiKeyPrincipal = {
    account_id,
    api_key_id: 1,
    key_id: "requester-key",
    scope_revision: 1,
    auth_method: "api_key",
    capabilities: [],
    allowed_project_ids: [],
  };
  const input = () => ({
    request_id: randomUUID(),
    action: { kind: "revoke_api_key", target_key_id: "target-key" },
  });
  beforeAll(async () => {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS accounts(account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN)",
    );
    await pool.query("INSERT INTO accounts VALUES($1,'bay-0',false)", [
      account_id,
    ]);
    await pool.query(`CREATE TABLE api_keys(id INTEGER, key_id TEXT PRIMARY KEY, account_id UUID,
      name TEXT, trunc TEXT, scope JSONB, scope_revision INTEGER, capabilities TEXT[], allowed_project_ids UUID[], expire TIMESTAMPTZ)`);
    await pool.query("CREATE TABLE agent_cocalc_connector_turns(key_id TEXT)");
    await pool.query(
      "CREATE TABLE account_financial_handoffs(account_id UUID, state TEXT)",
    );
  });
  beforeEach(async () => {
    homeMock.mockReset().mockResolvedValue({ home_bay_id: "bay-0" });
    freshMock.mockReset().mockResolvedValue({});
    tombstoneMock.mockReset().mockResolvedValue(undefined);
    bannedMock.mockReset().mockReturnValue(false);
    await pool.query("DELETE FROM api_keys");
    await pool.query("DELETE FROM agent_cocalc_connector_turns");
    await pool.query("DELETE FROM account_financial_handoffs");
    await pool.query(
      "UPDATE accounts SET home_bay_id='bay-0', deleted=false WHERE account_id=$1",
      [account_id],
    );
    await pool.query(
      `INSERT INTO api_keys VALUES(1,'requester-key',$1,'Requester','req',$2::JSONB,1,'{}','{}',now()+interval '5 minutes'),
      (2,'target-key',$1,'Target','tar',$3::JSONB,3,'{}','{}',NULL)`,
      [
        account_id,
        JSON.stringify(scope),
        JSON.stringify({ version: 1, account: ["account:read"], projects: [] }),
      ],
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("requires human fresh auth and commits exact-target revocation once", async () => {
    const reviewed = await requestApiKeyActionLocal(principal, input());
    expect(reviewed.binding).toEqual({
      account_id,
      requesting_key_id: "requester-key",
      requesting_scope_revision: 1,
      target_key_id: "target-key",
      target_scope_revision: 3,
    });
    const options = {
      account_id,
      session_hash: "human-session",
      reviewed,
      decision: "execute" as const,
    };
    freshMock.mockRejectedValueOnce(new Error("fresh auth required"));
    await expect(decideApiKeyActionLocal(options)).rejects.toThrow(
      "fresh auth required",
    );
    expect(
      (await pool.query("SELECT * FROM api_keys WHERE key_id='target-key'"))
        .rows,
    ).toHaveLength(1);
    expect((await decideApiKeyActionLocal(options)).status).toBe("executed");
    expect((await decideApiKeyActionLocal(options)).status).toBe("executed");
    expect(
      (await pool.query("SELECT * FROM api_keys WHERE key_id='target-key'"))
        .rows,
    ).toHaveLength(0);
    expect(freshMock).toHaveBeenCalledWith({
      account_id,
      session_hash: "human-session",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(tombstoneMock).toHaveBeenCalledWith({
      account_id,
      key_id: "target-key",
      home_bay_id: "bay-0",
    });
  });

  it("lists pending unexpired reviews only after human authentication", async () => {
    const expired = await requestApiKeyActionLocal(principal, input());
    await pool.query(
      "UPDATE api_key_action_requests SET expires_at=0 WHERE request_id=$1",
      [expired.request_id],
    );
    const live = await requestApiKeyActionLocal(principal, input());
    await expect(
      listApiKeyActionsLocal({ account_id, session_hash: "" }),
    ).rejects.toThrow("human authentication");
    const rows = await listApiKeyActionsLocal({
      account_id,
      session_hash: "human-session",
    });
    expect(rows.some((row) => row.request_id === live.request_id)).toBe(true);
    expect(rows.some((row) => row.request_id === expired.request_id)).toBe(
      false,
    );
    expect(
      rows.every(
        (row) =>
          row.binding.account_id === account_id && row.status === "pending",
      ),
    ).toBe(true);
  });

  it("fails closed for wrong home, banned owner, missing scope, and self-target", async () => {
    homeMock.mockResolvedValueOnce({ home_bay_id: "other-bay" });
    await expect(requestApiKeyActionLocal(principal, input())).rejects.toThrow(
      "account home",
    );
    bannedMock.mockReturnValueOnce(true);
    await expect(requestApiKeyActionLocal(principal, input())).rejects.toThrow(
      "unavailable",
    );
    await expect(
      requestApiKeyActionLocal(principal, {
        ...input(),
        action: { kind: "revoke_api_key", target_key_id: "requester-key" },
      }),
    ).rejects.toThrow("own key");
    await pool.query(
      "UPDATE api_keys SET scope=$1::JSONB WHERE key_id='requester-key'",
      [JSON.stringify({ version: 1, account: ["account:read"], projects: [] })],
    );
    await expect(requestApiKeyActionLocal(principal, input())).rejects.toThrow(
      "lacks management request scope",
    );
  });

  it("rejects managed targets and identity substitution", async () => {
    await expect(
      requestApiKeyActionLocal({ ...principal, api_key_id: 99 }, input()),
    ).rejects.toThrow("identity changed");
    await pool.query(
      "INSERT INTO agent_cocalc_connector_turns VALUES('target-key')",
    );
    await expect(requestApiKeyActionLocal(principal, input())).rejects.toThrow(
      "manual API key",
    );
    await expect(
      requestApiKeyActionLocal(principal, {
        ...input(),
        account_id: randomUUID(),
      }),
    ).rejects.toThrow("unknown");
  });

  it.each(["requester-key", "target-key"])(
    "rejects a changed %s revision at approval",
    async (key_id) => {
      const reviewed = await requestApiKeyActionLocal(principal, input());
      await pool.query(
        "UPDATE api_keys SET scope_revision=scope_revision+1 WHERE key_id=$1",
        [key_id],
      );
      await expect(
        decideApiKeyActionLocal({
          account_id,
          session_hash: "human-session",
          reviewed,
          decision: "execute",
        }),
      ).rejects.toThrow(/changed/);
      expect(
        (await pool.query("SELECT * FROM api_keys WHERE key_id='target-key'"))
          .rows,
      ).toHaveLength(1);
    },
  );

  it("rejects revoked requesters and another approving account", async () => {
    const reviewed = await requestApiKeyActionLocal(principal, input());
    await expect(
      decideApiKeyActionLocal({
        account_id: randomUUID(),
        session_hash: "human-session",
        reviewed,
        decision: "execute",
      }),
    ).rejects.toThrow("owner mismatch");
    await pool.query("DELETE FROM api_keys WHERE key_id='requester-key'");
    await expect(
      decideApiKeyActionLocal({
        account_id,
        session_hash: "human-session",
        reviewed,
        decision: "execute",
      }),
    ).rejects.toThrow("unavailable");
  });

  it("does not repeat execution when directory cleanup fails after commit", async () => {
    const reviewed = await requestApiKeyActionLocal(principal, input());
    const options = {
      account_id,
      session_hash: "human-session",
      reviewed,
      decision: "execute" as const,
    };
    tombstoneMock.mockRejectedValueOnce(new Error("directory unavailable"));
    await expect(decideApiKeyActionLocal(options)).rejects.toThrow(
      "directory unavailable",
    );
    expect(
      (await pool.query("SELECT * FROM api_keys WHERE key_id='target-key'"))
        .rows,
    ).toHaveLength(0);
    expect((await decideApiKeyActionLocal(options)).status).toBe("executed");
  });

  it("rejects execution during a frozen rehome or after local ownership changes", async () => {
    const reviewed = await requestApiKeyActionLocal(principal, input());
    const options = {
      account_id,
      session_hash: "human-session",
      reviewed,
      decision: "execute" as const,
    };
    await pool.query(
      "INSERT INTO account_financial_handoffs VALUES($1,'frozen')",
      [account_id],
    );
    await expect(decideApiKeyActionLocal(options)).rejects.toThrow(
      "rehome is frozen",
    );
    await pool.query("DELETE FROM account_financial_handoffs");
    await pool.query(
      "UPDATE accounts SET home_bay_id='bay-1' WHERE account_id=$1",
      [account_id],
    );
    await expect(decideApiKeyActionLocal(options)).rejects.toThrow(
      "homed on bay-1",
    );
    expect(
      (await pool.query("SELECT * FROM api_keys WHERE key_id='target-key'"))
        .rows,
    ).toHaveLength(1);
  });
});
