/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  closeProjectHostBootstrapExchanges,
  createProjectHostBootstrapToken,
  createProjectHostMasterConatToken,
  redeemProjectHostBootstrapToken,
  restoreProjectHostTokensForRestart,
  revokeProjectHostTokensForHost,
  verifyProjectHostToken,
} from "./bootstrap-token";

jest.mock("../launchpad/onprem-sshd", () => ({
  refreshLaunchpadOnPremAuthorizedKeys: jest.fn(async () => undefined),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("bootstrap token exchange", () => {
  beforeAll(async () => {
    await syncSchema({
      project_host_bootstrap_tokens: SCHEMA.project_host_bootstrap_tokens,
    });
  });

  const row = async (token_id: string) =>
    (
      await getPool().query(
        "SELECT * FROM project_host_bootstrap_tokens WHERE token_id=$1",
        [token_id],
      )
    ).rows[0];

  it("exchanges repeatedly until the host proves its master token (bootstrap.py, then the daemon's startup preflight)", async () => {
    const host = randomUUID();
    const { token, token_id } = await createProjectHostBootstrapToken(host);
    expect(await redeemProjectHostBootstrapToken(token)).toMatchObject({
      token_id,
      host_id: host,
    });
    const first = (await row(token_id)).redeemed;
    expect(first).toBeTruthy();
    expect(await redeemProjectHostBootstrapToken(token)).toMatchObject({
      host_id: host,
    });
    expect((await row(token_id)).redeemed).toEqual(first);
    expect(await closeProjectHostBootstrapExchanges(host)).toBe(1);
    // A second redemption after the host proved its token is refused.
    expect(await redeemProjectHostBootstrapToken(token)).toBeNull();
    // ...but the token still authenticates status and payload requests.
    expect(
      await verifyProjectHostToken(token, { purpose: "bootstrap" }),
    ).toMatchObject({ token_id, host_id: host });
  });

  it("a reboot with the stale startup-script token is refused harmlessly; a fresh start token is open until the next proof", async () => {
    const host = randomUUID();
    const first = await createProjectHostBootstrapToken(host);
    await redeemProjectHostBootstrapToken(first.token);
    await closeProjectHostBootstrapExchanges(host);
    expect(await redeemProjectHostBootstrapToken(first.token)).toBeNull();
    // Start/restart issues a new token (revoking the old one). A host whose
    // master token on disk is no longer valid can't prove it, so the fresh
    // token still recovers it.
    const second = await createProjectHostBootstrapToken(host);
    expect(await redeemProjectHostBootstrapToken(first.token)).toBeNull();
    expect(
      await verifyProjectHostToken(first.token, { purpose: "bootstrap" }),
    ).toBeNull();
    expect(await redeemProjectHostBootstrapToken(second.token)).toMatchObject({
      host_id: host,
    });
    expect(await redeemProjectHostBootstrapToken(second.token)).not.toBeNull();
    await closeProjectHostBootstrapExchanges(host);
    expect(await redeemProjectHostBootstrapToken(second.token)).toBeNull();
  });

  it("closing touches only that host's open bootstrap tokens", async () => {
    const host = randomUUID();
    const other = randomUUID();
    const mine = await createProjectHostBootstrapToken(host);
    const theirs = await createProjectHostBootstrapToken(other);
    const master = await createProjectHostMasterConatToken(host);
    expect(await closeProjectHostBootstrapExchanges(host)).toBe(1);
    expect(await closeProjectHostBootstrapExchanges(host)).toBe(0);
    expect(await redeemProjectHostBootstrapToken(theirs.token)).not.toBeNull();
    expect((await row(master.token_id)).exchange_closed).toBeNull();
    expect((await row(mine.token_id)).exchange_closed).toBeTruthy();
  });

  it("restoring a revoked token for a restart does not reopen its exchange", async () => {
    const host = randomUUID();
    const { token } = await createProjectHostBootstrapToken(host);
    await closeProjectHostBootstrapExchanges(host);
    await revokeProjectHostTokensForHost(host, { purpose: "bootstrap" });
    expect(await restoreProjectHostTokensForRestart(host)).toEqual({
      restored: ["bootstrap"],
    });
    expect(
      await verifyProjectHostToken(token, { purpose: "bootstrap" }),
    ).not.toBeNull();
    expect(await redeemProjectHostBootstrapToken(token)).toBeNull();
  });

  it("refuses wrong secrets, revoked, expired and non-bootstrap tokens", async () => {
    const host = randomUUID();
    const { token, token_id } = await createProjectHostBootstrapToken(host);
    expect(
      await redeemProjectHostBootstrapToken(`${token_id}.wrong-secret`),
    ).toBeNull();
    expect(await redeemProjectHostBootstrapToken("garbage")).toBeNull();
    const short = await createProjectHostBootstrapToken(randomUUID(), {
      ttlMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await redeemProjectHostBootstrapToken(short.token)).toBeNull();
    await revokeProjectHostTokensForHost(host);
    expect(await redeemProjectHostBootstrapToken(token)).toBeNull();
    const master = await createProjectHostMasterConatToken(randomUUID());
    expect(await redeemProjectHostBootstrapToken(master.token)).toBeNull();
  });

  it("concurrent redemptions racing a close never succeed after it", async () => {
    const host = randomUUID();
    const { token } = await createProjectHostBootstrapToken(host);
    await closeProjectHostBootstrapExchanges(host);
    const results = await Promise.all(
      [1, 2, 3].map(() => redeemProjectHostBootstrapToken(token)),
    );
    expect(results).toEqual([null, null, null]);
  });
});
