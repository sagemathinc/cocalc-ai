import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Command } from "commander";
import { registerChatAgentCommands } from "./chat-agents";

function program(calls: unknown[]) {
  const command = new Command();
  registerChatAgentCommands(command.command("chat"), {
    globalsFrom: () => ({}),
    emitSuccess: (_ctx: unknown, _label: string, value: unknown) =>
      calls.push(value),
    withContext: () => {
      throw new Error("human credential fallback is forbidden");
    },
  } as any);
  return command;
}

test("destinations discovers network peers with the runtime identity", async () => {
  const requests: unknown[] = [];
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: unknown) => {
      requests.push(request);
      return { peers: [] };
    },
  );
  const output: unknown[] = [];
  try {
    await program(output).parseAsync(["chat", "agent", "destinations"], {
      from: "user",
    });
    assert.deepEqual(requests, [{ version: 3, action: "destinations" }]);
    assert.deepEqual(output, [{ peers: [] }]);
  } finally {
    transport.mock.restore();
  }
});

test("network proposal and broadcast carry explicit bounded topology", async () => {
  const requests: any[] = [];
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: unknown) => {
      requests.push(request);
      return request;
    },
  );
  const source = { project_id: randomUUID(), agent_id: randomUUID() };
  const target = { project_id: randomUUID(), agent_id: randomUUID() };
  const network = randomUUID();
  try {
    await program([]).parseAsync(
      [
        "chat",
        "agent",
        "propose-network",
        "--members",
        JSON.stringify([
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: target },
        ]),
        "--reason",
        "review",
      ],
      { from: "user" },
    );
    await program([]).parseAsync(
      [
        "chat",
        "agent",
        "broadcast",
        "Please",
        "review",
        "--agent-network",
        network,
        "--targets",
        JSON.stringify([target]),
      ],
      { from: "user" },
    );
    assert.equal(requests[0].version, 3);
    assert.equal(requests[0].action, "propose-network");
    assert.equal(requests[0].members.length, 2);
    assert.equal(requests[1].action, "broadcast");
    assert.equal(requests[1].agent_network_id, network);
    assert.equal(requests[1].body, "Please review");
  } finally {
    transport.mock.restore();
  }
});
