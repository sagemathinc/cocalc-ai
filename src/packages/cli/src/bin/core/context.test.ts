import assert from "node:assert/strict";
import test from "node:test";

import { createHubApiForContext } from "./context";

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
