/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createRenewableCliLease } from "./claude-cli-lease";

function fakeLeases() {
  const created: { id: number; closed: boolean; close: () => Promise<void> }[] =
    [];
  const create = jest.fn(async () => {
    const lease = {
      id: created.length + 1,
      closed: false,
      close: async () => {
        lease.closed = true;
      },
    };
    created.push(lease);
    return lease;
  });
  return { created, create };
}

test("reuses the live lease", async () => {
  const { create } = fakeLeases();
  const leases = createRenewableCliLease(create);
  const first = await leases.acquire();
  expect(await leases.acquire()).toBe(first);
  expect(create).toHaveBeenCalledTimes(1);
});

test("a fence retires the lease, and the next command gets a fresh one", async () => {
  // ops3 on alpha, 2026-10-15: after one unconfirmed job cleanup the session's
  // identity file was gone for every later command and turn.
  const { created, create } = fakeLeases();
  const leases = createRenewableCliLease(create);
  const first = await leases.acquire();
  await leases.retire();
  expect(first.closed).toBe(true);
  expect(leases.current).toBeUndefined();
  const second = await leases.acquire();
  expect(second).not.toBe(first);
  expect(second.closed).toBe(false);
  expect(created).toHaveLength(2);
});

test("concurrent commands share one renewal", async () => {
  const { create } = fakeLeases();
  const leases = createRenewableCliLease(create);
  const [a, b] = await Promise.all([leases.acquire(), leases.acquire()]);
  expect(a).toBe(b);
  expect(create).toHaveBeenCalledTimes(1);
});

test("a lease created across a fence is discarded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { created, create } = fakeLeases();
  const leases = createRenewableCliLease(async () => {
    await gate;
    return await create();
  });
  const renewing = leases.acquire();
  // Another job's cleanup is unconfirmed while the renewal is in flight.
  await leases.retire();
  release();
  await expect(renewing).rejects.toThrow("revoked");
  expect(created[0].closed).toBe(true);
  expect(leases.current).toBeUndefined();
});

test("close is final, including for a renewal in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { created, create } = fakeLeases();
  const leases = createRenewableCliLease(async () => {
    await gate;
    return await create();
  });
  const renewing = leases.acquire();
  const closing = leases.close();
  release();
  await closing;
  await expect(renewing).rejects.toThrow();
  expect(created[0].closed).toBe(true);
  await expect(leases.acquire()).rejects.toThrow("closed");
});

test("no credentials is an error, not a lease", async () => {
  const leases = createRenewableCliLease(async () => undefined);
  await expect(leases.acquire()).rejects.toThrow(
    "Scoped Claude CLI credentials unavailable",
  );
});
