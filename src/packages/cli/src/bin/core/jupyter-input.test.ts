import assert from "node:assert/strict";
import test from "node:test";
import type { JupyterInputRequest } from "@cocalc/conat/project/jupyter/run-input";
import { createJupyterInputResponder } from "./jupyter-input";
import { createJupyterReplayReader } from "./jupyter-replay";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const prompt = (sequence = 1): JupyterInputRequest => ({
  id: "cell",
  prompt: "value?",
  password: true,
  request_id: `request-${sequence}`,
  sequence,
  expires_at: Date.now() + 60_000,
});

test("direct and recovered prompts share a callback without blocking polling", async () => {
  const response = deferred<string>();
  let calls = 0;
  const sent: string[] = [];
  const input = createJupyterInputResponder(async () => {
    calls++;
    return response.promise;
  });
  const request = prompt();
  const direct = input.handle(request);
  const client = {
    getInput: async () => request,
    answerInput: async (_run: string, _id: string, answer: string) => {
      sent.push(answer);
      return { status: "accepted" as const };
    },
  };
  await input.recover(client, "run", () => 1000);
  assert.equal(calls, 1);
  assert.deepEqual(sent, []);
  response.resolve("synthetic-answer");
  assert.equal(await direct, "synthetic-answer");
  await input.recover(client, "run", () => 1000);
  await input.recover(client, "run", () => 1000);
  assert.deepEqual(sent, ["synthetic-answer"]);
  await assert.rejects(input.handle(request), /Stale/);
  input.close();
});

test("an uncertain answer acknowledgment retries the same request without reprompting", async () => {
  let calls = 0;
  let submissions = 0;
  const input = createJupyterInputResponder(async () => {
    calls++;
    return "answer";
  });
  const request = prompt();
  await input.handle(request);
  const client = {
    getInput: async () => request,
    answerInput: async (_run: string, id: string, answer: string) => {
      assert.equal(id, request.request_id);
      assert.equal(answer, "answer");
      if (++submissions === 1) throw Error("lost acknowledgment");
      return { status: "already-accepted" as const };
    },
  };
  await assert.rejects(
    input.recover(client, "run", () => 1000),
    /lost acknowledgment/,
  );
  await input.recover(client, "run", () => 1000);
  assert.equal(calls, 1);
  assert.equal(submissions, 2);
  input.close();
});

test("closed responders ignore late lookup and callback results", async () => {
  const lookup = deferred<JupyterInputRequest>();
  let calls = 0;
  const input = createJupyterInputResponder(async () => {
    calls++;
    return "answer";
  });
  const pending = input.recover(
    {
      getInput: () => lookup.promise,
      answerInput: async () => {
        throw Error("must not send");
      },
    },
    "run",
    () => 1000,
  );
  input.close();
  lookup.resolve(prompt());
  await pending;
  assert.equal(calls, 0);
  const answer = deferred<string>();
  const second = createJupyterInputResponder(() => answer.promise);
  const callback = second.handle(prompt());
  await Promise.resolve();
  second.close();
  answer.resolve("late-secret");
  await assert.rejects(callback, /no longer active/);
});

test("newer prompt sequences reject stale callbacks and callback errors are sanitized", async () => {
  let calls = 0;
  const input = createJupyterInputResponder(async () => {
    calls++;
    return "answer";
  });
  await input.handle(prompt(2));
  await assert.rejects(input.handle(prompt(1)), /Stale/);
  assert.equal(calls, 1);
  input.close();
  const failed = createJupyterInputResponder(async () => {
    throw Error("synthetic-secret");
  });
  const request = prompt();
  await assert.rejects(failed.handle(request), {
    message: "Jupyter input callback failed",
  });
  await assert.rejects(
    failed.recover(
      {
        getInput: async () => request,
        answerInput: async () => {
          throw Error("must not send");
        },
      },
      "run",
      () => 1000,
    ),
    { message: "Jupyter input callback failed" },
  );
  failed.close();
});

test("input lookup shares the replay deadline and cannot invoke a callback after timeout", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const lookup = deferred<JupyterInputRequest>();
  let calls = 0;
  let closed = 0;
  const input = createJupyterInputResponder(async () => {
    calls++;
    return "answer";
  });
  const reader = createJupyterReplayReader({
    input,
    runId: "run",
    timeoutMs: 100,
    signal: new AbortController().signal,
    createClient: () => ({
      socket: { state: "ready" },
      close: () => {
        closed++;
      },
      getRun: async () => ({
        path: "test.ipynb",
        updated_at_ms: Date.now(),
        run_id: "run",
        batches: [],
        next_seq: 0,
        has_more: false,
        done: false,
      }),
      getInput: () => lookup.promise,
      answerInput: async () => {
        throw Error("must not send");
      },
    }),
  });
  const pending = reader.readPage(0);
  const rejected = assert.rejects(pending, { code: 408 });
  await Promise.resolve();
  t.mock.timers.tick(100);
  await rejected;
  lookup.resolve(prompt());
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(calls, 0);
  assert.equal(closed, 1);
  reader.close();
});
