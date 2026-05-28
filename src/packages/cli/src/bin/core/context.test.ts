import assert from "node:assert/strict";
import test from "node:test";

import { createHubApiForContext, hubCallByName } from "./context";

test("createHubApiForContext exposes the notifications hub group", async () => {
  const calls: Array<{ name: string; args: any[]; timeout?: number }> = [];
  const callByName = async <T>(
    name: string,
    args: any[] = [],
    timeout?: number,
  ): Promise<T> => {
    calls.push({ name, args, timeout });
    return { ok: true } as T;
  };
  const hub = createHubApiForContext(callByName);

  const result = await hub.notifications.counts({ account_id: "acct-1" });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    {
      name: "notifications.counts",
      args: [{ account_id: "acct-1" }],
      timeout: undefined,
    },
  ]);
});

test("createHubApiForContext forwards explicit per-call timeout", async () => {
  const calls: Array<{ name: string; args: any[]; timeout?: number }> = [];
  const hub = createHubApiForContext(async <T>(name, args = [], timeout) => {
    calls.push({ name, args, timeout });
    return { ok: true } as T;
  });

  await (hub.hosts.updateHostMachine as any)({
    id: "host-1",
    shared_disk_gb: 100,
    timeout: 120_000,
  });

  assert.deepEqual(calls, [
    {
      name: "hosts.updateHostMachine",
      args: [{ id: "host-1", shared_disk_gb: 100, timeout: 120_000 }],
      timeout: 120_000,
    },
  ]);
});

test("hubCallByName forwards auth_session_hash from the remote user", async () => {
  const calls: Array<Record<string, unknown>> = [];

  await hubCallByName({
    ctx: {
      timeoutMs: 15_000,
      rpcTimeoutMs: 15_000,
      accountId: "acct-1",
      remote: {
        client: {} as any,
        user: {
          auth_session_hash: "session-hash-1",
        },
      },
    },
    name: "system.createImpersonationGrant",
    args: [{ subject_account_id: "acct-2" }],
    callHub: async (opts) => {
      calls.push(opts);
      return { ok: true };
    },
  });

  assert.deepEqual(calls, [
    {
      client: {},
      account_id: "acct-1",
      auth_session_hash: "session-hash-1",
      name: "system.createImpersonationGrant",
      args: [{ subject_account_id: "acct-2" }],
      timeout: 15_000,
    },
  ]);
});

test("hubCallByName lets explicit timeouts exceed the default rpc timeout", async () => {
  const calls: Array<Record<string, unknown>> = [];

  await hubCallByName({
    ctx: {
      timeoutMs: 600_000,
      rpcTimeoutMs: 30_000,
      accountId: "acct-1",
      remote: {
        client: {} as any,
      },
    },
    name: "hosts.updateHostMachine",
    args: [{ id: "host-1", timeout: 120_000 }],
    timeout: 120_000,
    callHub: async (opts) => {
      calls.push(opts);
      return { ok: true };
    },
  });

  assert.equal(calls[0].timeout, 120_000);
});
