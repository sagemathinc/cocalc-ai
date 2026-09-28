import assert from "node:assert/strict";
import test from "node:test";
import { createJupyterReplayReader } from "./jupyter-replay";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("replay deadline includes readiness and retries, and closes a stalled client", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const first = deferred<null>();
  const second = deferred<null>();
  const budgets: number[] = [];
  let created = 0;
  let closed = 0;
  const reader = createJupyterReplayReader({
    runId: "same-run",
    signal: new AbortController().signal,
    timeoutMs: 100,
    createClient: () => {
      const response = created++ === 0 ? first : second;
      return {
        socket: { state: "disconnected" },
        close: () => {
          closed++;
        },
        getRun: async (runId, options, requestOptions) => {
          assert.equal(runId, "same-run");
          assert.equal(options?.after_seq, 7);
          budgets.push(requestOptions!.timeout!);
          return await response.promise;
        },
      };
    },
  });
  const pending = reader.readPage(7);
  const rejected = assert.rejects(pending, { code: 408 });
  t.mock.timers.tick(60);
  first.reject(Error("disconnected"));
  // Allow the getRun rejection and the single read retry to run.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(budgets, [100, 40]);
  t.mock.timers.tick(40);
  await rejected;
  assert.equal(created, 2);
  assert.equal(closed, 2);
  second.reject(Error("late disconnect"));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(created, 2);
  reader.close();
  assert.equal(closed, 2);
});

test("abort and explicit close settle a hung read without creating another client", async () => {
  for (const mode of ["abort", "close"] as const) {
    const controller = new AbortController();
    const response = deferred<null>();
    let created = 0;
    let closed = 0;
    const reader = createJupyterReplayReader({
      runId: "run",
      signal: controller.signal,
      createClient: () => {
        created++;
        return {
          socket: { state: "disconnected" },
          close: () => {
            closed++;
          },
          getRun: async () => await response.promise,
        };
      },
    });
    const pending = reader.readPage(0);
    const rejected = assert.rejects(pending, /closed|aborted/);
    if (mode === "abort") controller.abort();
    else reader.close();
    await rejected;
    response.resolve(null);
    await Promise.resolve();
    assert.equal(created, 1);
    assert.equal(closed, 1);
    await assert.rejects(reader.readPage(0), /closed|aborted/);
    reader.close();
  }
});

test("authorization denials never trigger a retry", async () => {
  for (const code of [401, "403"]) {
    let created = 0;
    let closed = 0;
    const reader = createJupyterReplayReader({
      runId: "run",
      signal: new AbortController().signal,
      createClient: () => {
        created++;
        return {
          socket: { state: "disconnected" },
          close: () => {
            closed++;
          },
          getRun: async () => {
            throw Object.assign(Error("denied"), { code });
          },
        };
      },
    });
    await assert.rejects(reader.readPage(0), { code });
    assert.equal(created, 1);
    reader.close();
    assert.equal(closed, 1);
  }
});

test("successful pages reuse their authorized client and missing output remains null", async () => {
  let created = 0;
  let closed = 0;
  const cursors: number[] = [];
  const reader = createJupyterReplayReader({
    runId: "run",
    signal: new AbortController().signal,
    createClient: () => {
      created++;
      return {
        socket: { state: "ready" },
        close: () => {
          closed++;
        },
        getRun: async (runId, options) => {
          assert.equal(runId, "run");
          cursors.push(options!.after_seq!);
          return null;
        },
      };
    },
  });
  assert.equal(await reader.readPage(3), null);
  assert.equal(await reader.readPage(6), null);
  assert.equal(created, 1);
  assert.deepEqual(cursors, [3, 6]);
  reader.close();
  assert.equal(closed, 1);
});
