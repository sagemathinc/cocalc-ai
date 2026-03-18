import assert from "node:assert/strict";
import test from "node:test";

import { createHostHelpers } from "./host-helpers";

test("waitForHostCreateReady waits for a heartbeat after running status", async () => {
  let calls = 0;
  const helpers = createHostHelpers({
    listHosts: async () => {
      calls += 1;
      if (calls === 1) {
        return [{ id: "host-1", status: "running" }];
      }
      return [
        {
          id: "host-1",
          status: "running",
          last_seen: "2026-03-18T14:00:00.000Z",
        },
      ];
    },
    resolveHost: async () => {
      throw new Error("not used in this test");
    },
    parseSshServer: () => ({ host: "127.0.0.1", port: 22 }),
    cliDebug: () => {},
  });

  const result = await helpers.waitForHostCreateReady({} as any, "host-1", {
    timeoutMs: 50,
    pollMs: 0,
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.host.id, "host-1");
  assert.equal(calls, 2);
});
