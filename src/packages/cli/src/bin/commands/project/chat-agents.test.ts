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
  watchSentTurn,
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
        same_project: false,
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
        same_project: false,
        available: true,
        networks: [{ title: "Development", delivery_mode: "live" }],
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(value), /agent_network_id|project_id/);
});

test("friendly discovery names an external agent by what agent send takes", () => {
  const member = (label: string, member_id = randomUUID()) => ({
    member: {
      kind: "external" as const,
      member_id,
      source: {
        kind: "external" as const,
        account_id: randomUUID(),
        agent_id: member_id,
        installation_id: randomUUID(),
      },
      label,
      available: true,
      added_at: new Date().toISOString(),
    },
    networks: [],
  });
  const unnamed = randomUUID();
  const value = friendlyAgentDestinations({
    peers: [
      member("ops0 on alpha.cocalc.ai (ops project)"),
      member("(unnamed)", unnamed),
    ],
  });
  assert.deepEqual(
    value.peers.map(({ name, label }: any) => ({ name, label })),
    [
      { name: "ops0", label: "ops0 on alpha.cocalc.ai (ops project)" },
      { name: unnamed, label: "(unnamed)" },
    ],
  );
});

test("friendly discovery says what a peer is doing", () => {
  const peer = (name: string, status?: any) => ({
    member: {
      kind: "registered" as const,
      member_id: randomUUID(),
      endpoint: { project_id: randomUUID(), agent_id: randomUUID() },
      name,
      available: true,
      added_at: new Date().toISOString(),
      ...(status ? { status } : {}),
    },
    networks: [],
  });
  const now = Date.now();
  const value = friendlyAgentDestinations({
    peers: [
      peer("matlab", {
        version: 1,
        running: 0,
        queued: 0,
        unavailable: { reason: "limit", until: now + 3_600_000 },
        at: now,
      }),
      peer("reviewer", { version: 1, running: 1, queued: 0, at: now }),
      peer("quiet"),
    ],
  });
  const status = value.peers.map((p: any) => p.status);
  assert.match(status[0], /^unavailable until .+ \(usage limit\)$/);
  assert.equal(status[1], "busy");
  assert.equal(status[2], undefined);
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

function peers(delivery_mode = "live") {
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
        delivery_mode,
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
    // Before waiting, the way to check without resending (a shell that
    // times out still has it).
    const before = stderr.mock.calls
      .map((call) => `${call.arguments[0]}`)
      .join("");
    assert.match(
      before,
      new RegExp(
        `Sending \\(attempt ${send.attempt_id}\\)\\. If this is cut off, check without resending: cocalc agent rpc inspect ${send.attempt_id} --agent-network ${network} --to-agent ${send.target.agent_id} --target-project ${send.target.project_id}`,
      ),
    );
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

test("agent send --report-no-reply asks to hear of a turn without a reply", async () => {
  const { directory } = peers("queued");
  for (const flag of [true, false]) {
    const requests: any[] = [];
    const transport = fakeHub(directory, requests);
    const stderr = mock.method(process.stderr, "write", () => true);
    try {
      await topLevel([]).parseAsync(
        [
          "agent",
          "send",
          "reviewer",
          ...(flag ? ["--report-no-reply"] : []),
          "Please",
          "review",
        ],
        { from: "user" },
      );
      const send = requests.find((request) => request.action === "send");
      assert.equal(send.report_no_reply, flag ? true : undefined);
    } finally {
      stderr.mock.restore();
      transport.mock.restore();
    }
  }
});

test("agent rpc withdraw takes back an exact attempt and says what happened", async () => {
  const attempt_id = randomUUID();
  const network = randomUUID();
  const target = { project_id: randomUUID(), agent_id: randomUUID() };
  const requests: any[] = [];
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: any) => {
      requests.push(request);
      return {
        version: 3,
        attempt_id,
        agent_network_id: network,
        target,
        outcome: "accepted",
        observed_at: Date.now(),
        reason: "Withdrawn: its turn will not run",
      };
    },
  );
  const output: any[] = [];
  try {
    await topLevel(output).parseAsync(
      [
        "agent",
        "rpc",
        "withdraw",
        attempt_id,
        "--agent-network",
        network,
        "--to-agent",
        target.agent_id,
        "--target-project",
        target.project_id,
      ],
      { from: "user" },
    );
    assert.deepEqual(requests, [
      {
        version: 3,
        action: "withdraw",
        attempt_id,
        agent_network_id: network,
        target,
      },
    ]);
    assert.match(
      output[0].summary,
      /^Withdrawn: the recipient will not run it/,
    );
  } finally {
    transport.mock.restore();
  }
});

test("agent send --report-no-reply refuses a live network, sending nothing", async () => {
  const { directory } = peers("live");
  const requests: any[] = [];
  const transport = fakeHub(directory, requests);
  const stderr = mock.method(process.stderr, "write", () => true);
  try {
    await assert.rejects(
      topLevel([]).parseAsync(
        ["agent", "send", "reviewer", "--report-no-reply", "Please", "review"],
        { from: "user" },
      ),
      /--report-no-reply is not possible here: .*delivers live.*no message was sent/,
    );
    assert.equal(
      requests.some((request) => request.action === "send"),
      false,
    );
  } finally {
    stderr.mock.restore();
    transport.mock.restore();
  }
});

test("agent send --watch-turn sets a watcher on the turn it started", async () => {
  const { network, directory } = peers();
  const requests: any[] = [];
  const transport = fakeHub(directory, requests);
  const stderr = mock.method(process.stderr, "write", () => true);
  try {
    await topLevel([]).parseAsync(
      ["agent", "send", "reviewer", "--watch-turn", "Please", "review"],
      { from: "user" },
    );
    const send = requests.find((request) => request.action === "send");
    const watch = requests.find((request) => request.action === "sensor");
    assert.deepEqual(watch, {
      action: "sensor",
      op: "watch",
      watch: {
        type: "agent-turn",
        attempt_id: send.attempt_id,
        agent_network_id: network,
        target: directory.peers[0].member.endpoint,
        name: "reviewer",
      },
    });
    await assert.rejects(
      topLevel([]).parseAsync(
        [
          "agent",
          "send",
          "reviewer",
          "--watch-turn",
          "--external-agent",
          "laptop",
          "hi",
        ],
        { from: "user" },
      ),
      /--watch-turn needs this agent's own sensors/,
    );
  } finally {
    stderr.mock.restore();
    transport.mock.restore();
  }
});

test("no watcher when there is no turn of its own to watch", async () => {
  const base = {
    version: 3 as const,
    attempt_id: randomUUID(),
    agent_network_id: randomUUID(),
    target: { project_id: randomUUID(), agent_id: randomUUID() },
    observed_at: Date.now(),
  };
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async () => assert.fail("no watcher should be set"),
  );
  try {
    assert.match(
      (await watchSentTurn({ outcome: { ...base, outcome: "rejected" } }))
        .summary,
      /not accepted/,
    );
    assert.match(
      (
        await watchSentTurn({
          outcome: {
            ...base,
            outcome: "accepted",
            operation: { id: "op", disposition: "steered" },
          },
        })
      ).summary,
      /joined the recipient's running turn/,
    );
  } finally {
    transport.mock.restore();
  }
});

test("a watcher that cannot be set leaves the send a success", async () => {
  const { directory } = peers();
  const requests: any[] = [];
  const hub = fakeHub(directory, requests);
  hub.mock.restore();
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: any) => {
      requests.push(request);
      if (request.action === "sensor")
        throw new Error("too many active watchers");
      if (request.action === "destinations") return directory;
      return {
        version: 3,
        attempt_id: request.attempt_id,
        agent_network_id: request.agent_network_id,
        target: request.target,
        outcome: "accepted",
        observed_at: Date.now(),
        chat_effect: "saved",
      };
    },
  );
  const stderr = mock.method(process.stderr, "write", () => true);
  const output: any[] = [];
  try {
    await topLevel(output).parseAsync(
      ["agent", "send", "reviewer", "--watch-turn", "Please", "review"],
      { from: "user" },
    );
    assert.equal(output[0].outcome, "accepted");
    assert.match(
      output[0].summary,
      /No watcher was set \(too many active watchers\)/,
    );
    assert.match(output[0].summary, /do not send it again/);
  } finally {
    stderr.mock.restore();
    transport.mock.restore();
  }
});

test("agent turn sets the current turn's subject and priority", async () => {
  const calls: any[] = [];
  const output: unknown[] = [];
  const command = new Command();
  registerAgentCommands(
    command.command("agent"),
    {
      globalsFrom: () => ({}),
      emitSuccess: (_ctx: unknown, _label: string, value: unknown) =>
        output.push(value),
      withContext: async (
        _cmd: unknown,
        _name: string,
        fn: any,
        options: any,
      ) => {
        calls.push({ options });
        output.push(await fn({ ctx: true }));
      },
      projectChatTurnMetaData: async (request: any) => {
        calls.push(request);
        return { message_id: "m1", subject: request.subject ?? null };
      },
    } as any,
    "agent",
  );
  const saved = { ...process.env };
  process.env.COCALC_CODEX_CHAT_PATH = "/home/user/a.chat";
  process.env.COCALC_CODEX_THREAD_ID = "thread-1";
  process.env.COCALC_CODEX_MESSAGE_DATE = "2026-10-23T01:00:00.000Z";
  try {
    await command.parseAsync(
      ["agent", "turn", "--subject", "Fixed it", "--priority", "HIGH"],
      { from: "user" },
    );
    const request = calls.find((call) => call.path);
    assert.equal(request.path, "/home/user/a.chat");
    assert.equal(request.threadId, "thread-1");
    assert.equal(request.messageDate, "2026-10-23T01:00:00.000Z");
    assert.equal(request.subject, "Fixed it");
    assert.equal(request.priority, "high");
    // The project's own credential, never an account fallback.
    assert.ok(calls[0].options.projectOnly);
    for (const args of [
      ["agent", "turn"],
      ["agent", "turn", "--priority", "urgent"],
    ]) {
      await assert.rejects(command.parseAsync(args, { from: "user" }));
    }
    delete process.env.COCALC_CODEX_MESSAGE_DATE;
    await assert.rejects(
      command.parseAsync(["agent", "turn", "--priority", "low"], {
        from: "user",
      }),
      /no current turn/,
    );
  } finally {
    process.env = saved;
  }
});

test("rpc inspect reaches an external member by account and installation", async () => {
  const requests: any[] = [];
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: any) => {
      requests.push(request);
      return {
        version: 3,
        attempt_id: request.attempt_id,
        agent_network_id: request.agent_network_id,
        target: request.target,
        outcome: "accepted",
        observed_at: Date.now(),
        inbox: {
          state: "pending",
          created_at: "2026-10-23T10:00:00.000Z",
          expires_at: "2026-10-30T10:00:00.000Z",
        },
      };
    },
  );
  try {
    const [network, agent, account, installation, attempt] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const output: any[] = [];
    await topLevel(output).parseAsync(
      [
        "agent",
        "rpc",
        "inspect",
        attempt,
        "--agent-network",
        network,
        "--to-agent",
        agent,
        "--target-account",
        account,
        "--target-installation",
        installation,
      ],
      { from: "user" },
    );
    assert.deepEqual(requests[0].target, {
      kind: "external",
      account_id: account,
      agent_id: agent,
      installation_id: installation,
    });
    assert.match(output[0].summary, /^Not read yet/);
    await assert.rejects(
      topLevel([]).parseAsync(
        [
          "agent",
          "rpc",
          "inspect",
          attempt,
          "--agent-network",
          network,
          "--to-agent",
          agent,
          "--target-account",
          account,
        ],
        { from: "user" },
      ),
      /--target-account and --target-installation/,
    );
  } finally {
    transport.mock.restore();
  }
});
