/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  createRenewableCliLease,
  leasedProjectExecutor,
} from "./claude-cli-lease";

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

test("a fence holds new leases until reopened, then the next command gets a fresh one", async () => {
  // ops3 on alpha, 2026-10-15: after one unconfirmed job cleanup the session's
  // identity file was gone for every later command and turn.
  const { created, create } = fakeLeases();
  const leases = createRenewableCliLease(create);
  const first = await leases.acquire();
  const { reopen, closed } = leases.retire();
  await closed;
  expect(first.closed).toBe(true);
  expect(leases.current).toBeUndefined();
  await expect(leases.acquire()).rejects.toThrow("paused");
  reopen();
  const second = await leases.acquire();
  expect(second).not.toBe(first);
  expect(second.closed).toBe(false);
  expect(created).toHaveLength(2);
});

test("every fence must be lifted", async () => {
  const { create } = fakeLeases();
  const leases = createRenewableCliLease(create);
  await leases.acquire();
  const a = leases.retire();
  const b = leases.retire();
  a.reopen();
  await expect(leases.acquire()).rejects.toThrow("paused");
  b.reopen();
  await expect(leases.acquire()).resolves.toBeDefined();
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
  // Another command's cleanup is unconfirmed while the renewal is in flight.
  leases.retire().reopen();
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

describe("leased project executor", () => {
  const signal = new AbortController().signal;
  const options = () => ({
    timeoutMs: 1000,
    onOutput: () => {},
    onCleanupConfirmed: jest.fn(),
  });

  test("an unconfirmed command keeps new leases fenced until its own proof", async () => {
    const { created, create } = fakeLeases();
    const leases = createRenewableCliLease(create);
    let proveFirst!: () => void;
    let finishFirst!: () => void;
    const execute = jest.fn(async (env, script, _cwd, _signal, opts) => {
      if (script === "first") {
        proveFirst = opts.onCleanupConfirmed;
        await new Promise<void>((resolve) => (finishFirst = resolve));
        return { stdout: "", stderr: "", code: null, cleanupConfirmed: false };
      }
      opts.onCleanupConfirmed();
      return {
        stdout: env.LEASE,
        stderr: "",
        code: 0,
        cleanupConfirmed: true,
      };
    });
    const executor = leasedProjectExecutor({
      leases,
      envFor: (lease) => ({ LEASE: `${lease.id}` }),
      execute,
    });
    const first = executor("first", undefined, signal, options());
    await new Promise((resolve) => setImmediate(resolve));
    finishFirst();
    await first;
    expect(created[0].closed).toBe(true);
    // A command arriving now, before the tool layer has fenced itself, must
    // not get fresh credentials while the first command may still run.
    const early = options();
    const blocked = await executor("second", undefined, signal, early);
    expect(blocked).toMatchObject({ code: null, cleanupConfirmed: true });
    expect(blocked.stderr).toMatch(/not started.*Nothing ran/);
    expect(early.onCleanupConfirmed).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    // The runtime's late recovery proves the first command's cleanup.
    proveFirst();
    const after = await executor("third", undefined, signal, options());
    expect(after).toMatchObject({ stdout: "2", cleanupConfirmed: true });
  });

  test("a command gets the values of when it was asked for, even if its lease comes later", async () => {
    let issue!: () => void;
    const issued = new Promise<void>((resolve) => (issue = resolve));
    const leases = createRenewableCliLease(async () => {
      await issued;
      return { id: 1, close: async () => {} };
    });
    let turn = "turn-1";
    const execute = jest.fn(async (env, _script, _cwd, _signal, opts) => {
      opts.onCleanupConfirmed();
      return { stdout: "", stderr: "", code: 0, cleanupConfirmed: true };
    });
    const executor = leasedProjectExecutor({
      leases,
      envFor: (lease) => ({ LEASE: `${lease.id}`, TURN: "from-lease" }),
      admissionEnv: () => ({ TURN: turn }),
      execute,
    });
    const running = executor("x", undefined, signal, options());
    // The turn ends (its values cleared) before the lease is issued.
    turn = "";
    issue();
    await running;
    expect(execute.mock.calls[0][0]).toEqual({ LEASE: "1", TURN: "turn-1" });
  });

  test("a proof that arrives before the result does not leave a fence up", async () => {
    const { create } = fakeLeases();
    const leases = createRenewableCliLease(create);
    const executor = leasedProjectExecutor({
      leases,
      envFor: () => ({}),
      execute: async (_env, _script, _cwd, _signal, opts) => {
        opts.onCleanupConfirmed();
        return { stdout: "", stderr: "", code: null, cleanupConfirmed: false };
      },
    });
    await executor("x", undefined, signal, options());
    await expect(leases.acquire()).resolves.toBeDefined();
  });

  test("failing to issue a lease is reported as not started, not as a lost job", async () => {
    const leases = createRenewableCliLease<{
      close: () => Promise<void>;
    }>(async () => {
      throw Error("bearer issuance failed");
    });
    const execute = jest.fn();
    const executor = leasedProjectExecutor({
      leases,
      envFor: () => ({}),
      execute,
    });
    const opts = options();
    const result = await executor("x", undefined, signal, opts);
    expect(result).toMatchObject({ code: null, cleanupConfirmed: true });
    expect(result.stderr).toContain("bearer issuance failed");
    expect(opts.onCleanupConfirmed).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("a command that throws stays fenced: there is no proof", async () => {
    const { create } = fakeLeases();
    const leases = createRenewableCliLease(create);
    const executor = leasedProjectExecutor({
      leases,
      envFor: () => ({}),
      execute: async () => {
        throw Error("transport lost");
      },
    });
    await expect(executor("x", undefined, signal, options())).rejects.toThrow(
      "transport lost",
    );
    await expect(leases.acquire()).rejects.toThrow("paused");
  });
});
