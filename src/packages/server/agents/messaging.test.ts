import { randomUUID } from "node:crypto";
import { agentInboxPrefix } from "@cocalc/conat/agents/protocol";
import { acceptAgentRpc } from "./rpc";
import { startAgentMessaging } from "./messaging";

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));
jest.mock("./rpc", () => ({
  acceptAgentRpc: jest.fn(),
  acceptExternalAgentRpc: jest.fn(),
}));
jest.mock("./store", () => ({ agentStore: jest.fn() }));
jest.mock("./access", () => ({ assertAgent: jest.fn(), assertRun: jest.fn() }));
jest.mock("./maintenance", () => ({
  startAgentMessagingMaintenance: () => () => {},
}));
jest.mock("./session-cutover", () => ({
  retireLegacyAgentMessagingAuthority: jest.fn(async () => {}),
}));
jest.mock("./memory-home", () => ({ withMemoryHome: jest.fn() }));
jest.mock("./sensors", () => ({ agentSensorRequest: jest.fn() }));
jest.mock("./sensor-scheduler", () => ({
  startSensorScheduler: () => () => {},
}));

/** A subscription the test feeds; it ends when closed. */
function subscription() {
  const queue: any[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(message: any) {
      queue.push(message);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length) yield queue.shift();
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}

test("a full hub refuses with exactly the fixed message and code, nothing else", async () => {
  const internal = subscription();
  const external = subscription();
  const client: any = {
    subscribe: jest.fn(async (subject: string) =>
      subject.startsWith("agent-external") ? external : internal,
    ),
    close: jest.fn(),
  };
  // Admitted requests stay in flight until released, filling the hub.
  const release: (() => void)[] = [];
  jest
    .mocked(acceptAgentRpc)
    .mockImplementation(
      () =>
        new Promise((resolve) => release.push(() => resolve({} as any))) as any,
    );
  const stop = await startAgentMessaging(client);
  const agent_id = randomUUID();
  const run_id = randomUUID();
  const message = () => ({
    subject: `agent-messaging.${agent_id}.${run_id}`,
    headers: { "CN-Reply": `${agentInboxPrefix(agent_id, run_id)}.reply` },
    data: { version: 3, action: "send", body: "private-body-marker" },
    respond: jest.fn(async () => {}),
  });
  const admitted = [message(), message(), message(), message()];
  const refused = message();
  for (const m of [...admitted, refused]) internal.push(m);
  for (let i = 0; i < 100 && refused.respond.mock.calls.length === 0; i++)
    await new Promise((resolve) => setImmediate(resolve));

  expect(acceptAgentRpc).toHaveBeenCalledTimes(4);
  expect(refused.respond).toHaveBeenCalledTimes(1);
  const reply = (refused.respond.mock.calls[0] as any[])[0];
  expect(reply).toStrictEqual({
    error: "agent RPC admission capacity reached",
    code: "rpc_admission_capacity",
  });
  expect(Object.keys(reply).sort()).toEqual(["code", "error"]);
  for (const m of admitted) expect(m.respond).not.toHaveBeenCalled();

  release.forEach((done) => done());
  internal.close();
  external.close();
  await stop();
  for (const m of admitted)
    expect(m.respond).toHaveBeenCalledWith({ result: {} });
});
