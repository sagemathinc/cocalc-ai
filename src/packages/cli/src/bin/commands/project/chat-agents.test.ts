import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Command } from "commander";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  friendlyAgentDestinations,
  registerAgentCommands,
  registerChatAgentCommands,
} from "./chat-agents";

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

test("friendly discovery omits internal identifiers", () => {
  const value = friendlyAgentDestinations({
    peers: [
      {
        member: {
          kind: "registered",
          member_id: randomUUID(),
          endpoint: { project_id: randomUUID(), agent_id: randomUUID() },
          name: "reviewer",
          project_title: "CoCalc",
          available: true,
          added_at: new Date().toISOString(),
        },
        networks: [
          {
            agent_network_id: randomUUID(),
            title: "Development",
            delivery_mode: "live",
            generation: randomUUID(),
          },
        ],
      },
    ],
  });
  assert.deepEqual(value, {
    peers: [
      {
        kind: "registered",
        name: "reviewer",
        project: "CoCalc",
        available: true,
        networks: [{ title: "Development", delivery_mode: "live" }],
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(value), /agent_network_id|project_id/);
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

function topLevel(calls: unknown[]) {
  const command = new Command();
  command.exitOverride();
  registerAgentCommands(
    command.command("agent"),
    {
      globalsFrom: () => ({}),
      emitSuccess: (_ctx: unknown, _label: string, value: unknown) =>
        calls.push(value),
      withContext: () => {
        throw new Error("human credential fallback is forbidden");
      },
    } as any,
    "agent",
  );
  return command;
}

function peers() {
  const network = randomUUID();
  const peer = (name: string) => ({
    member: {
      kind: "registered",
      member_id: randomUUID(),
      endpoint: { project_id: randomUUID(), agent_id: randomUUID() },
      name,
      project_title: "Support",
      available: true,
      added_at: new Date().toISOString(),
    },
    networks: [
      {
        agent_network_id: network,
        title: "cocalc",
        delivery_mode: "live",
        generation: randomUUID(),
      },
    ],
  });
  return { network, directory: { peers: [peer("reviewer"), peer("tester")] } };
}

function fakeHub(directory: unknown, requests: any[]) {
  return mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: any) => {
      requests.push(request);
      if (request.action === "destinations") return directory;
      if (request.action === "send")
        return {
          version: 3,
          attempt_id: request.attempt_id,
          agent_network_id: request.agent_network_id,
          target: request.target,
          outcome: "accepted",
          observed_at: Date.now(),
          chat_effect: "saved",
        };
      return request;
    },
  );
}

test("cocalc agent send takes a name and reports a readable outcome", async () => {
  const { network, directory } = peers();
  const requests: any[] = [];
  const output: any[] = [];
  const transport = fakeHub(directory, requests);
  const stderr = mock.method(process.stderr, "write", () => true);
  try {
    await topLevel(output).parseAsync(
      ["agent", "send", "@reviewer", "Please", "review"],
      { from: "user" },
    );
    const send = requests.find((request) => request.action === "send");
    assert.equal(send.body, "Please review");
    assert.equal(send.agent_network_id, network);
    assert.deepEqual(send.target, directory.peers[0].member.endpoint);
    assert.match(
      output[0].summary,
      /^Delivered to @reviewer \(Support\) via Agent Network "cocalc"/,
    );
    assert.equal(output[0].outcome, "accepted");
    assert.equal(process.exitCode, 0);
  } finally {
    stderr.mock.restore();
    transport.mock.restore();
    process.exitCode = 0;
  }
});

test("the message comes from exactly one of arguments, --stdin and --file", async () => {
  const { directory } = peers();
  const requests: any[] = [];
  const transport = fakeHub(directory, requests);
  const stderr = mock.method(process.stderr, "write", () => true);
  const file = join(mkdtempSync(join(tmpdir(), "agent-send-")), "message.md");
  try {
    writeFileSync(file, "From a file\n");
    await topLevel([]).parseAsync(
      ["agent", "send", "reviewer", "--file", file],
      {
        from: "user",
      },
    );
    assert.equal(
      requests.find((request) => request.action === "send").body,
      "From a file\n",
    );
    await assert.rejects(
      topLevel([]).parseAsync(
        ["agent", "send", "reviewer", "hi", "--file", file],
        {
          from: "user",
        },
      ),
      /exactly one/,
    );
    writeFileSync(file, "x".repeat(40000));
    await assert.rejects(
      topLevel([]).parseAsync(["agent", "send", "reviewer", "--file", file], {
        from: "user",
      }),
      /over 32768 bytes/,
    );
    // A huge sparse file is rejected after reading at most 32 KiB + 1.
    const sparse = join(mkdtempSync(join(tmpdir(), "agent-send-")), "sparse");
    const handle = openSync(sparse, "w");
    ftruncateSync(handle, 1024 ** 4);
    closeSync(handle);
    await assert.rejects(
      topLevel([]).parseAsync(["agent", "send", "reviewer", "--file", sparse], {
        from: "user",
      }),
      /over 32768 bytes/,
    );
    await assert.rejects(
      topLevel([]).parseAsync(
        ["agent", "send", "reviewer", "--file", dirname(sparse)],
        { from: "user" },
      ),
      /not a regular file|EISDIR/,
    );
  } finally {
    stderr.mock.restore();
    transport.mock.restore();
    process.exitCode = 0;
  }
});

test("broadcast --to resolves names and the shared network", async () => {
  const { network, directory } = peers();
  const requests: any[] = [];
  const transport = fakeHub(directory, requests);
  try {
    await topLevel([]).parseAsync(
      ["agent", "broadcast", "--to", "reviewer,tester", "Release", "tonight"],
      { from: "user" },
    );
    const broadcast = requests.find(
      (request) => request.action === "broadcast",
    );
    assert.equal(broadcast.agent_network_id, network);
    assert.deepEqual(broadcast.targets, [
      directory.peers[0].member.endpoint,
      directory.peers[1].member.endpoint,
    ]);
    assert.equal(broadcast.body, "Release tonight");
    assert.match(broadcast.broadcast_id, /^[0-9a-f-]{36}$/);
  } finally {
    transport.mock.restore();
  }
});

test("stdin stops at the message limit instead of buffering everything", async () => {
  const { directory } = peers();
  const requests: any[] = [];
  const transport = fakeHub(directory, requests);
  const { PassThrough } = require("node:stream");
  const input = new PassThrough();
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  let written = 0;
  // An endless producer: chunks keep coming until the reader stops.
  const pump = setInterval(() => {
    if (input.destroyed) return clearInterval(pump);
    input.write(Buffer.alloc(8192, 120));
    written += 8192;
  }, 1);
  try {
    await assert.rejects(
      topLevel([]).parseAsync(["agent", "send", "reviewer", "--stdin"], {
        from: "user",
      }),
      /over 32768 bytes/,
    );
    assert.ok(written < 1024 * 1024);
    assert.equal(requests.length, 0);
  } finally {
    clearInterval(pump);
    Object.defineProperty(process, "stdin", stdin);
    transport.mock.restore();
  }
});
