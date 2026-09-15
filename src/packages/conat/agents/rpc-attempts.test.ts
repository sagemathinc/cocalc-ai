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
  version: 2,
  attempt_id: randomUUID(),
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
