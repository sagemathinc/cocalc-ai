/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  _test,
  createProjectHostBootstrapToken,
  createProjectHostMasterConatToken,
  exchangeProjectHostBootstrapToken,
  proveProjectHostMasterToken,
  restoreProjectHostTokensForRestart,
  revokeProjectHostTokensForHost,
  verifyProjectHostToken,
} from "./bootstrap-token";

jest.mock("../launchpad/onprem-sshd", () => ({
  refreshLaunchpadOnPremAuthorizedKeys: jest.fn(async () => undefined),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const YEAR = 1000 * 60 * 60 * 24 * 365;

describeDb("bootstrap token exchange", () => {
  beforeAll(async () => {
    await syncSchema({
      project_host_bootstrap_tokens: SCHEMA.project_host_bootstrap_tokens,
    });
  });

  afterEach(() => {
    _test.hooks = {};
  });

  const row = async (token_id: string) =>
    (
      await getPool().query(
        "SELECT * FROM project_host_bootstrap_tokens WHERE token_id=$1",
        [token_id],
      )
    ).rows[0];

  const exchange = (token: string, hostId?: string) =>
    exchangeProjectHostBootstrapToken(token, { hostId, ttlMs: YEAR });

  const isMasterValid = async (token: string) =>
    !!(await verifyProjectHostToken(token, { purpose: "master-conat" }));

  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let reached!: () => void;
    const wasReached = new Promise<void>((resolve) => (reached = resolve));
    return {
      hook: async () => {
        reached();
        await opened;
      },
      open,
      wasReached,
    };
  }

  it("exchanges repeatedly until the host proves its master token (bootstrap.py, then the daemon's startup preflight)", async () => {
    const host = randomUUID();
    const { token, token_id } = await createProjectHostBootstrapToken(host);
    const first = await exchange(token);
    expect(first).toMatchObject({ ok: true, host_id: host });
    const redeemed = (await row(token_id)).redeemed;
    expect(redeemed).toBeTruthy();
    const second = await exchange(token);
    expect(second.ok).toBe(true);
    expect((await row(token_id)).redeemed).toEqual(redeemed);
    // Each mint revokes the previous master token, as before.
    if (!first.ok || !second.ok) throw Error("unreachable");
    expect(await isMasterValid(first.master.token)).toBe(false);
    expect(await isMasterValid(second.master.token)).toBe(true);

    expect(
      await proveProjectHostMasterToken(host, second.master.token_id),
    ).toBe(1);
    // A second redemption after the host proved its token is refused...
    expect(await exchange(token)).toEqual({
      ok: false,
      reason: "exchange_closed",
      host_id: host,
    });
    expect(await isMasterValid(second.master.token)).toBe(true);
    // ...but the token still authenticates status and payload requests.
    expect(
      await verifyProjectHostToken(token, { purpose: "bootstrap" }),
    ).toMatchObject({ token_id, host_id: host });
  });

  it("a revoked or foreign master token proves nothing", async () => {
    const host = randomUUID();
    const { token } = await createProjectHostBootstrapToken(host);
    const old = await createProjectHostMasterConatToken(host);
    await createProjectHostMasterConatToken(host); // revokes old
    expect(await proveProjectHostMasterToken(host, old.token_id)).toBe(0);
    const foreign = await createProjectHostMasterConatToken(randomUUID());
    expect(await proveProjectHostMasterToken(host, foreign.token_id)).toBe(0);
    expect((await exchange(token)).ok).toBe(true);
  });

  it("a lost rotation response after a proof is recoverable: minting a new master token reopens the exchange", async () => {
    const host = randomUUID();
    const { token } = await createProjectHostBootstrapToken(host);
    const m = await createProjectHostMasterConatToken(host);
    // ensureMasterConatToken: status check (proof), then rotation...
    expect(await proveProjectHostMasterToken(host, m.token_id)).toBe(1);
    expect((await exchange(token)).ok).toBe(false);
    const n = await createProjectHostMasterConatToken(host);
    // ...whose response is lost: the host still holds M, now revoked.
    expect(await isMasterValid(m.token)).toBe(false);
    expect(await proveProjectHostMasterToken(host, m.token_id)).toBe(0);
    const recovered = await exchange(token);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw Error("unreachable");
    expect(await isMasterValid(n.token)).toBe(false);
    expect(
      await proveProjectHostMasterToken(host, recovered.master.token_id),
    ).toBe(1);
    expect((await exchange(token)).ok).toBe(false);
  });

  it("race: a proof can't close the exchange under an exchange that already passed its check", async () => {
    const host = randomUUID();
    const { token } = await createProjectHostBootstrapToken(host);
    const m = await createProjectHostMasterConatToken(host);
    const g = gate();
    _test.hooks.afterExchangeCheck = g.hook;
    const attacker = exchange(token);
    await g.wasReached;
    _test.hooks.afterExchangeCheck = undefined;
    let proofSettled = false;
    const proof = proveProjectHostMasterToken(host, m.token_id).finally(() => {
      proofSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(proofSettled).toBe(false); // waits for the exchange's lock
    g.open();
    const minted = await attacker;
    expect(minted.ok).toBe(true);
    // The exchange won: M is revoked, so the host's proof closes nothing and
    // the host can still recover with the bootstrap token.
    expect(await proof).toBe(0);
    expect(await isMasterValid(m.token)).toBe(false);
    expect((await exchange(token)).ok).toBe(true);
  });

  it("race: an exchange that starts while a proof holds the lock is refused", async () => {
    const host = randomUUID();
    const { token } = await createProjectHostBootstrapToken(host);
    const m = await createProjectHostMasterConatToken(host);
    const g = gate();
    _test.hooks.beforeProofCheck = g.hook;
    const proof = proveProjectHostMasterToken(host, m.token_id);
    await g.wasReached;
    _test.hooks.beforeProofCheck = undefined;
    let exchangeSettled = false;
    const attacker = exchange(token).finally(() => {
      exchangeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exchangeSettled).toBe(false);
    g.open();
    expect(await proof).toBe(1);
    expect(await attacker).toMatchObject({
      ok: false,
      reason: "exchange_closed",
    });
    expect(await isMasterValid(m.token)).toBe(true);
  });

  it("concurrent mints leave exactly one valid master token", async () => {
    const host = randomUUID();
    const { token } = await createProjectHostBootstrapToken(host);
    await Promise.all([
      exchange(token),
      exchange(token),
      createProjectHostMasterConatToken(host),
    ]);
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM project_host_bootstrap_tokens
       WHERE host_id=$1 AND purpose='master-conat' AND revoked IS NOT TRUE`,
      [host],
    );
    expect(rows[0].n).toBe(1);
  });

  it("a stale startup-script token is refused harmlessly after a restart; the fresh token is open until the next proof", async () => {
    const host = randomUUID();
    const first = await createProjectHostBootstrapToken(host);
    const m = await exchange(first.token);
    if (!m.ok) throw Error("unreachable");
    await proveProjectHostMasterToken(host, m.master.token_id);
    // Start/restart issues a new token (revoking the old one).
    const second = await createProjectHostBootstrapToken(host);
    expect((await exchange(first.token)).ok).toBe(false);
    expect(
      await verifyProjectHostToken(first.token, { purpose: "bootstrap" }),
    ).toBeNull();
    const fresh = await exchange(second.token);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw Error("unreachable");
    await proveProjectHostMasterToken(host, fresh.master.token_id);
    expect((await exchange(second.token)).ok).toBe(false);
  });

  it("checks the host binding before recording anything", async () => {
    const host = randomUUID();
    const { token, token_id } = await createProjectHostBootstrapToken(host);
    expect(await exchange(token, randomUUID())).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect((await row(token_id)).redeemed).toBeNull();
  });

  it("restoring a revoked token for a restart does not reopen its exchange", async () => {
    const host = randomUUID();
    const { token } = await createProjectHostBootstrapToken(host);
    const m = await exchange(token);
    if (!m.ok) throw Error("unreachable");
    await proveProjectHostMasterToken(host, m.master.token_id);
    await revokeProjectHostTokensForHost(host, { purpose: "bootstrap" });
    expect(await restoreProjectHostTokensForRestart(host)).toEqual({
      restored: ["bootstrap"],
    });
    expect(
      await verifyProjectHostToken(token, { purpose: "bootstrap" }),
    ).not.toBeNull();
    expect((await exchange(token)).ok).toBe(false);
  });

  it("refuses wrong secrets, revoked, expired and non-bootstrap tokens", async () => {
    const host = randomUUID();
    const { token, token_id } = await createProjectHostBootstrapToken(host);
    expect((await exchange(`${token_id}.wrong-secret`)).ok).toBe(false);
    expect((await exchange("garbage")).ok).toBe(false);
    const short = await createProjectHostBootstrapToken(randomUUID(), {
      ttlMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await exchange(short.token)).ok).toBe(false);
    await revokeProjectHostTokensForHost(host);
    expect((await exchange(token)).ok).toBe(false);
    const master = await createProjectHostMasterConatToken(randomUUID());
    expect((await exchange(master.token)).ok).toBe(false);
  });
});
