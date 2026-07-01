import assert from "node:assert/strict";
import test from "node:test";
import { waitForLro } from "./lro";

test("waitForLro retries transient busy polling errors", async () => {
  let calls = 0;
  const get = async () => {
    calls += 1;
    const busy = Object.assign(new Error("hub api server is busy"), {
      code: 503,
    });
    if (calls === 1) throw busy;
    if (calls === 2) return { status: "running" };
    if (calls === 3) throw Object.assign(new Error("timeout"), { code: 408 });
    return { status: "succeeded", result: { ok: true } };
  };

  const summary = await waitForLro({
    hub: { lro: { get } } as any,
    opId: "op-1",
    timeoutMs: 5000,
    pollMs: 0,
    terminalStatuses: new Set(["succeeded", "failed"]),
  });

  assert.deepEqual(summary, {
    op_id: "op-1",
    status: "succeeded",
    error: null,
    result: { ok: true },
    progress_summary: undefined,
  });
  assert.equal(calls, 4);
});

test("waitForLro retries transient socket disconnect polling errors", async () => {
  let calls = 0;
  const get = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error(
        "socket has been disconnected - callHub: subject='hub.account.acct.api', name='lro.get'",
      );
    }
    return { status: "succeeded", result: { ok: true } };
  };

  const summary = await waitForLro({
    hub: { lro: { get } } as any,
    opId: "op-1",
    timeoutMs: 5000,
    pollMs: 0,
    terminalStatuses: new Set(["succeeded", "failed"]),
  });

  assert.deepEqual(summary.result, { ok: true });
  assert.equal(calls, 2);
});

test("waitForLro still throws non-transient polling errors", async () => {
  const err = Object.assign(new Error("permission denied"), { code: 403 });
  await assert.rejects(
    waitForLro({
      hub: {
        lro: {
          get: async () => {
            throw err;
          },
        },
      } as any,
      opId: "op-1",
      timeoutMs: 1000,
      pollMs: 0,
      terminalStatuses: new Set(["succeeded", "failed"]),
    }),
    /permission denied/,
  );
});
