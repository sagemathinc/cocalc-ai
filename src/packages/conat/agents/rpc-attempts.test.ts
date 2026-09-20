import { randomUUID } from "node:crypto";
import { AgentRpcAttempts } from "./rpc-attempts";
import {
  rpcOutcome,
  validateAgentRpcRequest,
  validateAgentRpcOutcome,
  type AgentRpcSend,
} from "./rpc";

const endpoint = () => ({ project_id: randomUUID(), agent_id: randomUUID() });
const request = (): AgentRpcSend => ({
  version: 3,
  attempt_id: randomUUID(),
  agent_network_id: randomUUID(),
  target: endpoint(),
  body: "review this",
});

test("acknowledgments must match the full attempt and a known outcome", () => {
  const send = request();
  const accepted = rpcOutcome(send, "accepted");
  expect(() => validateAgentRpcOutcome(accepted, send)).not.toThrow();
  for (const invalid of [
    undefined,
    { ...accepted, attempt_id: randomUUID() },
    { ...accepted, target: endpoint() },
    { ...accepted, outcome: "completed" },
    { ...accepted, observed_at: "yesterday" },
    { ...accepted, operation: null },
  ])
    expect(() => validateAgentRpcOutcome(invalid as any, send)).toThrow();
});

test("lost response can be inspected without starting work; explicit retry is new work", async () => {
  const evidence = new AgentRpcAttempts();
  const source = endpoint(),
    send = request();
  const execute = jest.fn(async () => rpcOutcome(send, "accepted"));
  await evidence.send(source, send, execute); // acknowledgment lost after handler completes
  expect(evidence.inspect(source, send).outcome).toBe("accepted");
  expect(execute).toHaveBeenCalledTimes(1);
  await evidence.send(source, { ...send, attempt_id: randomUUID() }, execute);
  expect(execute).toHaveBeenCalledTimes(2);
});

test("retained evidence is principal scoped, never a legacy fallback", async () => {
  const evidence = new AgentRpcAttempts();
  const source = endpoint(),
    send = request();
  const p = randomUUID(),
    q = randomUUID();
  const executeP = jest.fn(async () => rpcOutcome(send, "accepted"));
  const executeQ = jest.fn(async () => rpcOutcome(send, "rejected"));
  await evidence.send(source, send, executeP, p);
  expect(evidence.inspect(source, send, p).outcome).toBe("accepted");
  expect(evidence.inspect(source, send, q).outcome).toBe("unknown");
  expect(evidence.inspect(source, send).outcome).toBe("unknown");
  await evidence.send(source, send, executeQ, q);
  expect(evidence.inspect(source, send, q).outcome).toBe("rejected");
  expect(evidence.inspect(source, send, p).outcome).toBe("accepted");
  await evidence.send(source, send, executeP, p);
  expect(executeP).toHaveBeenCalledTimes(1);
  expect(executeQ).toHaveBeenCalledTimes(1);
  const legacy = jest.fn(async () => rpcOutcome(send, "unknown"));
  await evidence.send(source, send, legacy);
  expect(legacy).toHaveBeenCalledTimes(1);
  expect(evidence.inspect(source, send, p).outcome).toBe("accepted");
});

test("in-flight coalescing never joins another human's attempt", async () => {
  const evidence = new AgentRpcAttempts();
  const source = endpoint(),
    send = request();
  const p = randomUUID(),
    q = randomUUID();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const executeP = jest.fn(async () => {
    await held;
    return rpcOutcome(send, "accepted");
  });
  const first = evidence.send(source, send, executeP, p);
  const duplicate = evidence.send(source, send, executeP, p);
  const executeQ = jest.fn(async () => rpcOutcome(send, "rejected"));
  try {
    expect((await evidence.send(source, send, executeQ, q)).outcome).toBe(
      "rejected",
    );
    expect(evidence.inspect(source, send, p).outcome).toBe("unknown");
    expect(evidence.inspect(source, send, q).outcome).toBe("rejected");
    expect(executeP).toHaveBeenCalledTimes(1);
    expect(executeQ).toHaveBeenCalledTimes(1);
  } finally {
    finish();
  }
  expect((await first).outcome).toBe("accepted");
  expect((await duplicate).outcome).toBe("accepted");
  expect(evidence.inspect(source, send, q).outcome).toBe("rejected");
});

test("in-flight calls coalesce, conflict does not replay, other senders cannot inspect", async () => {
  const evidence = new AgentRpcAttempts();
  const source = endpoint(),
    send = request();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const execute = jest.fn(async () => {
    await held;
    return rpcOutcome(send, "accepted");
  });
  const first = evidence.send(source, send, execute);
  const second = evidence.send(source, send, execute);
  expect(evidence.inspect(source, send).outcome).toBe("unknown");
  expect(
    (await evidence.send(source, { ...send, body: "different" }, execute))
      .outcome,
  ).toBe("rejected");
  finish();
  await first;
  await second;
  expect(execute).toHaveBeenCalledTimes(1);
  expect(evidence.inspect(endpoint(), send).outcome).toBe("unknown");
});

test("expired evidence and restarted process are unknown; inspection never replays", async () => {
  let now = 0;
  const evidence = new AgentRpcAttempts({ now: () => now, ttlMs: 10 });
  const source = endpoint(),
    send = request();
  const execute = jest.fn(async () => rpcOutcome(send, "rejected"));
  await evidence.send(source, send, execute);
  expect(evidence.inspect(source, send).outcome).toBe("rejected");
  now = 11;
  expect(evidence.inspect(source, send).outcome).toBe("unknown");
  expect(new AgentRpcAttempts().inspect(source, send).outcome).toBe("unknown");
  expect(execute).toHaveBeenCalledTimes(1);
});

test("capacity does not evict ongoing work; unrelated targets can proceed", async () => {
  const evidence = new AgentRpcAttempts({ maxEntries: 1 });
  const source = endpoint(),
    send = request();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = evidence.send(source, send, async () => {
    await held;
    return rpcOutcome(send, "unknown");
  });
  const execute = jest.fn();
  expect((await evidence.send(source, request(), execute)).outcome).toBe(
    "rejected",
  );
  expect(execute).not.toHaveBeenCalled();
  finish();
  await first;
});

test("completed evidence is capped per principal without blocking another account", async () => {
  const evidence = new AgentRpcAttempts({
    maxEntries: 3,
    maxEntriesPerPrincipal: 2,
  });
  const source = endpoint();
  const accountP = randomUUID();
  const accountQ = randomUUID();
  const sends = [request(), request(), request()];
  for (const send of sends)
    await evidence.send(
      source,
      send,
      async () => rpcOutcome(send, "accepted"),
      accountP,
    );

  expect(evidence.inspect(source, sends[0], accountP).outcome).toBe("unknown");
  expect(evidence.inspect(source, sends[1], accountP).outcome).toBe("accepted");
  expect(evidence.inspect(source, sends[2], accountP).outcome).toBe("accepted");

  const other = request();
  const execute = jest.fn(async () => rpcOutcome(other, "accepted"));
  expect((await evidence.send(source, other, execute, accountQ)).outcome).toBe(
    "accepted",
  );
  expect(execute).toHaveBeenCalledTimes(1);
});

test("principal capacity never evicts in-flight evidence", async () => {
  const evidence = new AgentRpcAttempts({
    maxEntries: 4,
    maxEntriesPerPrincipal: 1,
  });
  const source = endpoint();
  const account = randomUUID();
  const firstSend = request();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = evidence.send(
    source,
    firstSend,
    async () => {
      await held;
      return rpcOutcome(firstSend, "accepted");
    },
    account,
  );
  const second = request();
  const execute = jest.fn(async () => rpcOutcome(second, "accepted"));
  expect((await evidence.send(source, second, execute, account)).outcome).toBe(
    "rejected",
  );
  expect(execute).not.toHaveBeenCalled();
  finish();
  await first;
});

test("global capacity yields completed evidence from the largest principal", async () => {
  const evidence = new AgentRpcAttempts({
    maxEntries: 3,
    maxEntriesPerPrincipal: 3,
  });
  const source = endpoint();
  const accountP = randomUUID();
  const accountQ = randomUUID();
  const accountR = randomUUID();
  const p1 = request();
  const p2 = request();
  const q = request();
  for (const [send, account] of [
    [p1, accountP],
    [p2, accountP],
    [q, accountQ],
  ] as const)
    await evidence.send(
      source,
      send,
      async () => rpcOutcome(send, "accepted"),
      account,
    );

  const newcomer = request();
  expect(
    (
      await evidence.send(
        source,
        newcomer,
        async () => rpcOutcome(newcomer, "accepted"),
        accountR,
      )
    ).outcome,
  ).toBe("accepted");
  expect(evidence.inspect(source, p1, accountP).outcome).toBe("unknown");
  expect(evidence.inspect(source, p2, accountP).outcome).toBe("accepted");
  expect(evidence.inspect(source, q, accountQ).outcome).toBe("accepted");
});

test("native agents in one account share rate and concurrency admission", async () => {
  const evidence = new AgentRpcAttempts();
  const account = randomUUID();
  const pending: Array<() => void> = [];
  const sends = Array.from({ length: 9 }, () => request());
  const work = sends.slice(0, 8).map((send) =>
    evidence.send(
      endpoint(),
      send,
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve(rpcOutcome(send, "accepted")));
        }),
      account,
    ),
  );
  const ninth = jest.fn(async () => rpcOutcome(sends[8], "accepted"));
  expect(
    (await evidence.send(endpoint(), sends[8], ninth, account)).outcome,
  ).toBe("rejected");
  expect(ninth).not.toHaveBeenCalled();
  for (const finish of pending) finish();
  await Promise.all(work);
});

test("rate rejection does not evict retained evidence", async () => {
  const evidence = new AgentRpcAttempts({
    maxEntries: 60,
    maxEntriesPerPrincipal: 60,
  });
  const source = endpoint();
  const account = randomUUID();
  const sends = Array.from({ length: 60 }, () => request());
  for (const send of sends)
    await evidence.send(
      source,
      send,
      async () => rpcOutcome(send, "accepted"),
      account,
    );

  const rejected = request();
  expect(
    (
      await evidence.send(
        source,
        rejected,
        async () => rpcOutcome(rejected, "accepted"),
        account,
      )
    ).outcome,
  ).toBe("rejected");
  expect(evidence.inspect(source, sends[0], account).outcome).toBe("accepted");
});

test("concurrency rejection cannot evict another principal's evidence", async () => {
  const evidence = new AgentRpcAttempts({
    maxEntries: 9,
    maxEntriesPerPrincipal: 9,
  });
  const accountP = randomUUID();
  const accountQ = randomUUID();
  const sourceP = endpoint();
  const sourceQ = endpoint();
  const retained = request();
  await evidence.send(
    sourceQ,
    retained,
    async () => rpcOutcome(retained, "accepted"),
    accountQ,
  );
  const pending: Array<() => void> = [];
  const active = Array.from({ length: 8 }, () => request()).map((send) =>
    evidence.send(
      sourceP,
      send,
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve(rpcOutcome(send, "accepted")));
        }),
      accountP,
    ),
  );

  const rejected = request();
  expect(
    (
      await evidence.send(
        sourceP,
        rejected,
        async () => rpcOutcome(rejected, "accepted"),
        accountP,
      )
    ).outcome,
  ).toBe("rejected");
  expect(evidence.inspect(sourceQ, retained, accountQ).outcome).toBe(
    "accepted",
  );
  for (const finish of pending) finish();
  await Promise.all(active);
});

test("validation bounds UTF-8 payloads and forbids claimed sender fields", () => {
  const send = { ...request(), action: "send" as const };
  expect(() => validateAgentRpcRequest(send)).not.toThrow();
  expect(() =>
    validateAgentRpcRequest({ ...send, body: "\u2603".repeat(11000) }),
  ).toThrow();
  expect(() =>
    validateAgentRpcRequest({ ...send, source: endpoint() } as any),
  ).toThrow();
  expect(() =>
    validateAgentRpcRequest({ ...send, guidance: "false" } as any),
  ).toThrow();
  expect(() =>
    validateAgentRpcRequest({ ...send, version: 1 } as any),
  ).toThrow();
});

test("changing attached file references conflicts with an existing attempt", async () => {
  const evidence = new AgentRpcAttempts(),
    source = endpoint();
  const send = {
    ...request(),
    file_references: [{ kind: "project-file" as const, path: "/tmp/first" }],
  };
  const execute = jest.fn(async () => rpcOutcome(send, "accepted"));
  await evidence.send(source, send, execute);
  const changed = {
    ...send,
    file_references: [{ kind: "project-file" as const, path: "/tmp/second" }],
  };
  expect((await evidence.send(source, changed, execute)).outcome).toBe(
    "rejected",
  );
  expect(execute).toHaveBeenCalledTimes(1);
});
