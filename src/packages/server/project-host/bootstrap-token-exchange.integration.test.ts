/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  BOOTSTRAP_EXCHANGE_RETRY_MS,
  closeProjectHostBootstrapTokenExchange,
  createProjectHostBootstrapToken,
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

  const backdateRedeemed = async (token_id: string, ms: number) =>
    await getPool().query(
      `UPDATE project_host_bootstrap_tokens
       SET redeemed=NOW() - $2 * INTERVAL '1 millisecond'
       WHERE token_id=$1`,
      [token_id, ms],
    );

  it("mints once, retries within the window, and refuses afterwards", async () => {
    const host = randomUUID();
    const { token, token_id } = await createProjectHostBootstrapToken(host);
    expect(await redeemProjectHostBootstrapToken(token)).toMatchObject({
      token_id,
      host_id: host,
    });
    // A lost response or the urllib -> curl fallback retries at once.
    expect(await redeemProjectHostBootstrapToken(token)).toMatchObject({
      host_id: host,
    });
    await backdateRedeemed(token_id, BOOTSTRAP_EXCHANGE_RETRY_MS + 1000);
    expect(await redeemProjectHostBootstrapToken(token)).toBeNull();
    // The retry did not move the first redemption forward.
    await backdateRedeemed(token_id, BOOTSTRAP_EXCHANGE_RETRY_MS - 60_000);
    expect(await redeemProjectHostBootstrapToken(token)).not.toBeNull();
  });

  it("refuses the exchange once bootstrap is done, but the token still authenticates status and payload requests", async () => {
    const host = randomUUID();
    const { token, token_id } = await createProjectHostBootstrapToken(host);
    await closeProjectHostBootstrapTokenExchange(token_id);
    expect(await redeemProjectHostBootstrapToken(token)).toBeNull();
    expect(
      await verifyProjectHostToken(token, { purpose: "bootstrap" }),
    ).toMatchObject({ token_id, host_id: host });
  });

  it("a stale token (reboot after the exchange) is refused harmlessly, and a new start's token works", async () => {
    const host = randomUUID();
    const first = await createProjectHostBootstrapToken(host);
    await redeemProjectHostBootstrapToken(first.token);
    await closeProjectHostBootstrapTokenExchange(first.token_id);
    expect(await redeemProjectHostBootstrapToken(first.token)).toBeNull();
    // Start/restart issues a new token (revoking the old one).
    const second = await createProjectHostBootstrapToken(host);
    expect(await redeemProjectHostBootstrapToken(first.token)).toBeNull();
    expect(
      await verifyProjectHostToken(first.token, { purpose: "bootstrap" }),
    ).toBeNull();
    expect(await redeemProjectHostBootstrapToken(second.token)).toMatchObject({
      host_id: host,
    });
  });

  it("restoring a revoked token for a restart does not reopen its exchange", async () => {
    const host = randomUUID();
    const { token, token_id } = await createProjectHostBootstrapToken(host);
    await closeProjectHostBootstrapTokenExchange(token_id);
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
    const { createProjectHostMasterConatToken } =
      await import("./bootstrap-token");
    const master = await createProjectHostMasterConatToken(randomUUID());
    expect(await redeemProjectHostBootstrapToken(master.token)).toBeNull();
  });

  it("concurrent redemptions after the window all fail", async () => {
    const host = randomUUID();
    const { token, token_id } = await createProjectHostBootstrapToken(host);
    await redeemProjectHostBootstrapToken(token);
    await backdateRedeemed(token_id, BOOTSTRAP_EXCHANGE_RETRY_MS + 1000);
    const results = await Promise.all(
      [1, 2, 3].map(() => redeemProjectHostBootstrapToken(token)),
    );
    expect(results).toEqual([null, null, null]);
  });
});
