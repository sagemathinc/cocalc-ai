/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { before, after, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { updateApiRelayQuota, type RelayQuotaRequest } from "./api-relay-quota";
import { getManagedEgressUsageForAccount } from "./managed-egress";

const mockLimits = {
  egress_5h_bytes: 10_000_000,
  egress_7d_bytes: 100_000_000,
};
jest.mock("./resolve", () => ({
  resolveMembershipForAccount: async () => ({ effective_limits: mockLimits }),
}));

beforeAll(async () => {
  await before({ noConat: true });
}, 30_000);
afterAll(after);
beforeEach(() => {
  mockLimits.egress_5h_bytes = 10_000_000;
  mockLimits.egress_7d_bytes = 100_000_000;
});

function request(): RelayQuotaRequest {
  return {
    account_id: uuid(),
    host_id: uuid(),
    project_id: uuid(),
    session_id: uuid(),
    sequence: 0,
    sent: 0,
    received: 0,
    transport: "websocket",
    target: "host:target",
  };
}

it("reserves atomically across hosts/projects, returns unused bytes, and deduplicates retries", async () => {
  mockLimits.egress_5h_bytes = 1_000;
  const first = request();
  const second = { ...request(), account_id: first.account_id };
  const grants = await Promise.all([
    updateApiRelayQuota(first),
    updateApiRelayQuota(second),
  ]);
  expect(grants.reduce((sum, g) => sum + g.allowance, 0)).toBe(1_000);
  const index = grants.findIndex((g) => g.allowance > 0);
  const winner = [first, second][index];
  await expect(updateApiRelayQuota(winner)).resolves.toEqual(grants[index]);
  const finish = {
    ...winner,
    sequence: 1,
    sent: 100,
    received: 200,
    close: true,
    reason: "completed",
  };
  await updateApiRelayQuota(finish);
  await updateApiRelayQuota(finish);
  const usage = await getManagedEgressUsageForAccount({
    account_id: first.account_id,
  });
  expect(usage.managed_egress_5h_bytes).toBe(300);
  const { rows } = await getPool().query(
    "SELECT SUM(bytes) AS bytes FROM account_managed_egress_rollups WHERE account_id=$1",
    [first.account_id],
  );
  expect(Number(rows[0].bytes)).toBe(300);
  const next = await updateApiRelayQuota({
    ...request(),
    account_id: first.account_id,
  });
  expect(next.allowance).toBe(700);
});

it("renews beyond 600 MiB without a per-connection cap and honors the tighter window", async () => {
  const bytes = 600 * 1024 * 1024;
  mockLimits.egress_5h_bytes = bytes + 1000;
  mockLimits.egress_7d_bytes = bytes;
  const initial = request();
  let current = initial;
  let grant = await updateApiRelayQuota(current);
  while (grant.allowance < bytes) {
    current = {
      ...current,
      sequence: current.sequence + 1,
      received: grant.allowance,
    };
    grant = await updateApiRelayQuota(current);
  }
  expect(grant.allowance).toBe(bytes);
  current = { ...current, sequence: current.sequence + 1, received: bytes };
  expect((await updateApiRelayQuota(current)).allowance).toBe(bytes);
  await updateApiRelayQuota({
    ...current,
    sequence: current.sequence + 1,
    close: true,
  });
  expect(
    (await getManagedEgressUsageForAccount({ account_id: initial.account_id }))
      .managed_egress_7d_bytes,
  ).toBe(bytes);
}, 30_000);

it("rejects altered retries, spoofed lease ownership and usage outside the reservation", async () => {
  const initial = request();
  const grant = await updateApiRelayQuota(initial);
  await expect(updateApiRelayQuota({ ...initial, sent: 1 })).rejects.toThrow(
    "sequence",
  );
  await expect(
    updateApiRelayQuota({ ...initial, host_id: uuid() }),
  ).rejects.toThrow("identity");
  await expect(
    updateApiRelayQuota({ ...initial, sequence: 1, sent: grant.allowance + 1 }),
  ).rejects.toThrow("usage");
  await updateApiRelayQuota({ ...initial, sequence: 1, close: true });
  await expect(
    updateApiRelayQuota({ ...initial, sequence: 2 }),
  ).rejects.toThrow("sequence");
});

it("returns unused allowance to old windows when a new usage period begins", async () => {
  const initial = request();
  await updateApiRelayQuota(initial);
  await getPool().query(
    "UPDATE account_usage_windows SET resets_at=now() WHERE account_id=$1",
    [initial.account_id],
  );
  const grant = await updateApiRelayQuota({
    ...initial,
    sequence: 1,
    sent: 100,
  });
  expect(grant.allowance).toBeGreaterThan(100);
  const { rows } = await getPool().query(
    `SELECT amount FROM account_usage_counters c
    JOIN account_usage_windows w ON w.id=c.usage_window_id WHERE w.account_id=$1 AND w.resets_at <= now()`,
    [initial.account_id],
  );
  expect(rows.map((r) => Number(r.amount))).toEqual([100, 100]);
});
