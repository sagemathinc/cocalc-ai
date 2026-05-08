import assert from "node:assert/strict";
import test from "node:test";

import { createHubApiForContext, hubCallByName } from "./context";

test("createHubApiForContext exposes the notifications hub group", async () => {
  const calls: Array<{ name: string; args: any[] }> = [];
  const callByName = async <T>(name: string, args: any[] = []): Promise<T> => {
    calls.push({ name, args });
    return { ok: true } as T;
  };
  const hub = createHubApiForContext(callByName);

  const result = await hub.notifications.counts({ account_id: "acct-1" });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    {
      name: "notifications.counts",
      args: [{ account_id: "acct-1" }],
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
