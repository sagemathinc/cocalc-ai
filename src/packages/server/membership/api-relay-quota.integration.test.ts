/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { before, after, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  updateApiRelayQuota,
  cleanupApiRelayQuota,
  API_RELAY_QUOTA_LIMITS,
  type RelayQuotaRequest,
} from "./api-relay-quota";
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
afterEach(() => jest.restoreAllMocks());
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
    started_at: Date.now(),
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

async function retained(accountId: string): Promise<number> {
  const { rows } = await getPool().query(
    "SELECT COUNT(*) AS n FROM account_api_relay_leases WHERE account_id=$1",
    [accountId],
  );
  return Number(rows[0].n);
}

it("bounds zero-byte connection churn across projects/hosts and collects settled retries without more traffic", async () => {
  jest.spyOn(Date, "now").mockReturnValue(Date.now());
  const initial = request();
  for (let i = 0; i < API_RELAY_QUOTA_LIMITS.startsPerMinute; i++) {
    const start = { ...request(), account_id: initial.account_id };
    await updateApiRelayQuota(start);
    await updateApiRelayQuota({ ...start, sequence: 1, close: true });
  }
  expect(await retained(initial.account_id)).toBe(
    API_RELAY_QUOTA_LIMITS.startsPerMinute,
  );
  await expect(updateApiRelayQuota(initial)).rejects.toThrow("admission rate");
  expect(
    (await getManagedEgressUsageForAccount({ account_id: initial.account_id }))
      .managed_egress_5h_bytes,
  ).toBe(0);
  await getPool().query(
    "UPDATE account_api_relay_leases SET delete_after=now()-interval '1 second' WHERE account_id=$1",
    [initial.account_id],
  );
  await cleanupApiRelayQuota();
  expect(await retained(initial.account_id)).toBe(0);
}, 30_000);

it("does not persist per-session state for exhausted accounts, and still bounds admission attempts", async () => {
  jest.spyOn(Date, "now").mockReturnValue(Date.now());
  mockLimits.egress_5h_bytes = 0;
  const initial = request();
  for (let i = 0; i < API_RELAY_QUOTA_LIMITS.startsPerMinute; i++) {
    expect(
      (
        await updateApiRelayQuota({
          ...request(),
          account_id: initial.account_id,
        })
      ).allowance,
    ).toBe(0);
  }
  for (let i = 0; i < 10; i++) {
    await expect(
      updateApiRelayQuota({ ...request(), account_id: initial.account_id }),
    ).rejects.toThrow("admission rate");
  }
  expect(await retained(initial.account_id)).toBe(0);
  const { rows } = await getPool().query(
    "SELECT COUNT(*) AS n FROM account_api_relay_admission WHERE account_id=$1",
    [initial.account_id],
  );
  expect(Number(rows[0].n)).toBe(1);
}, 30_000);

it("limits active sessions per account rather than per project or host", async () => {
  const initial = request();
  const sessions: RelayQuotaRequest[] = [];
  for (let i = 0; i < API_RELAY_QUOTA_LIMITS.activeSessions; i++) {
    if (i === API_RELAY_QUOTA_LIMITS.startsPerMinute) {
      await getPool().query(
        "UPDATE account_api_relay_admission SET updated_at=now()-interval '1 minute' WHERE account_id=$1",
        [initial.account_id],
      );
    }
    const start = { ...request(), account_id: initial.account_id };
    sessions.push(start);
    await updateApiRelayQuota(start);
  }
  await expect(updateApiRelayQuota(initial)).rejects.toThrow("session limit");
  await updateApiRelayQuota({ ...sessions[0], sequence: 1, close: true });
  expect((await updateApiRelayQuota(initial)).allowance).toBeGreaterThan(0);
}, 30_000);

it("has a hard retained-row bound even if cleanup is unavailable", async () => {
  const initial = request();
  await updateApiRelayQuota(initial);
  await getPool().query(
    `INSERT INTO account_api_relay_leases (session_id, account_id, state)
    SELECT gen_random_uuid(), $1, '{"closed":true}'::jsonb FROM generate_series(1,$2)`,
    [initial.account_id, API_RELAY_QUOTA_LIMITS.retainedSessions - 1],
  );
  await expect(
    updateApiRelayQuota({ ...request(), account_id: initial.account_id }),
  ).rejects.toThrow("session limit");
  expect(await retained(initial.account_id)).toBe(
    API_RELAY_QUOTA_LIMITS.retainedSessions,
  );
});

it("limits renewal work but permits exact retries and final settlement", async () => {
  const initial = request();
  const grant = await updateApiRelayQuota(initial);
  await getPool().query(
    "UPDATE account_api_relay_admission SET start_tokens=0, renewal_tokens=0, updated_at=now() WHERE account_id=$1",
    [initial.account_id],
  );
  await expect(updateApiRelayQuota(initial)).resolves.toEqual(grant);
  await expect(
    updateApiRelayQuota({ ...initial, sequence: 1, received: 10 }),
  ).rejects.toThrow("admission rate");
  await updateApiRelayQuota({
    ...initial,
    sequence: 1,
    received: 10,
    close: true,
  });
  expect(
    (await getManagedEgressUsageForAccount({ account_id: initial.account_id }))
      .managed_egress_5h_bytes,
  ).toBe(10);
});

it("serializes account creation budgets across simultaneous hosts", async () => {
  const initial = request();
  await updateApiRelayQuota(initial);
  await getPool().query(
    "UPDATE account_api_relay_admission SET start_tokens=1, updated_at=now() WHERE account_id=$1",
    [initial.account_id],
  );
  jest.spyOn(Date, "now").mockReturnValue(Date.now());
  const results = await Promise.allSettled([
    updateApiRelayQuota({ ...request(), account_id: initial.account_id }),
    updateApiRelayQuota({ ...request(), account_id: initial.account_id }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(await retained(initial.account_id)).toBe(2);
});

it("deduplicates settled retries only during their TTL and fences stale initial requests after cleanup", async () => {
  const initial = request();
  await updateApiRelayQuota(initial);
  const closed = { ...initial, sequence: 1, sent: 10, close: true };
  const result = await updateApiRelayQuota(closed);
  const expiry = await getPool().query(
    "SELECT delete_after FROM account_api_relay_leases WHERE session_id=$1",
    [initial.session_id],
  );
  expect(
    expiry.rows[0].delete_after.getTime() - Date.now(),
  ).toBeLessThanOrEqual(API_RELAY_QUOTA_LIMITS.settledRetentionMs);
  await expect(updateApiRelayQuota(closed)).resolves.toEqual(result);
  const after = await getPool().query(
    "SELECT delete_after FROM account_api_relay_leases WHERE session_id=$1",
    [initial.session_id],
  );
  expect(after.rows).toEqual(expiry.rows);
  await getPool().query(
    "UPDATE account_api_relay_leases SET delete_after=now()-interval '1 second' WHERE session_id=$1",
    [initial.session_id],
  );
  await expect(updateApiRelayQuota(closed)).rejects.toThrow("retry period");
  await cleanupApiRelayQuota();
  const clock = jest
    .spyOn(Date, "now")
    .mockReturnValue(
      initial.started_at + API_RELAY_QUOTA_LIMITS.settledRetentionMs + 1,
    );
  try {
    await expect(updateApiRelayQuota(initial)).rejects.toThrow(
      "initial request expired",
    );
  } finally {
    clock.mockRestore();
  }
  await expect(updateApiRelayQuota(closed)).rejects.toThrow("zero usage");
  expect(
    (await getManagedEgressUsageForAccount({ account_id: initial.account_id }))
      .managed_egress_5h_bytes,
  ).toBe(10);
});

it("collects uncertain expired reservations without refunding unknown transferred bytes", async () => {
  const initial = request();
  const grant = await updateApiRelayQuota(initial);
  await getPool().query(
    "UPDATE account_api_relay_leases SET delete_after=now()-interval '1 second' WHERE session_id=$1",
    [initial.session_id],
  );
  await cleanupApiRelayQuota();
  expect(await retained(initial.account_id)).toBe(0);
  expect(
    (await getManagedEgressUsageForAccount({ account_id: initial.account_id }))
      .managed_egress_5h_bytes,
  ).toBe(grant.allowance);
});

it("bounds each background cleanup batch and removes idle account budgets", async () => {
  const initial = request();
  await updateApiRelayQuota(initial);
  await getPool().query(
    `INSERT INTO account_api_relay_leases (session_id, account_id, state, delete_after)
    SELECT gen_random_uuid(), $1, '{"closed":true}'::jsonb, now()-interval '1 second' FROM generate_series(1,$2)`,
    [initial.account_id, API_RELAY_QUOTA_LIMITS.cleanupBatch + 10],
  );
  await getPool().query(
    "UPDATE account_api_relay_admission SET updated_at=now()-interval '2 days' WHERE account_id=$1",
    [initial.account_id],
  );
  const result = await cleanupApiRelayQuota();
  expect(result.leases).toBe(API_RELAY_QUOTA_LIMITS.cleanupBatch);
  expect(result.accounts).toBeGreaterThanOrEqual(1);
  expect(await retained(initial.account_id)).toBe(11);
});
