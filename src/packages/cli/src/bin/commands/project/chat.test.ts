import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import type { ProjectCommandDeps } from "../project";
import { registerProjectChatCommands } from "./chat";
import { parseAgentMessageRuntimeEvents } from "@cocalc/conat/agents/runtime-events";

test("named send uses one scoped attempt and never the human send path", async () => {
  const target = { project_id: randomUUID(), agent_id: randomUUID() };
  const agent_network_id = randomUUID();
  let resolved = 0;
  const attempts: any[] = [];
  let output: any;
  const resolver = mock.method(
    require("../../core/agent-destination"),
    "resolveRuntimeAgentName",
    async (name: string) => {
      assert.equal(name, "@reviewer");
      resolved++;
      return { target, agent_network_id };
    },
  );
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: any) => {
      attempts.push(request);
      return { ...request, outcome: "accepted", observed_at: Date.now() };
    },
  );
  const program = new Command();
  registerProjectChatCommands(program.command("project"), {
    globalsFrom: () => ({}),
    emitSuccess: (_ctx: unknown, _command: unknown, result: unknown) => {
      output = result;
    },
    withContext: () => {
      throw new Error("broad credential fallback");
    },
  } as any);
  const oldExit = process.exitCode;
  const oldAgentMode = process.env.COCALC_CLI_AGENT_MODE;
  const oldChatPath = process.env.COCALC_CODEX_CHAT_PATH;
  const oldThreadId = process.env.COCALC_CODEX_THREAD_ID;
  let stderr = "";
  const stderrWrite = mock.method(process.stderr, "write", (chunk: any) => {
    stderr += `${chunk}`;
    return true;
  });
  try {
    process.env.COCALC_CLI_AGENT_MODE = "1";
    process.env.COCALC_CODEX_CHAT_PATH = "agent.chat";
    process.env.COCALC_CODEX_THREAD_ID = randomUUID();
    await program.parseAsync(
      [
        "project",
        "chat",
        "send",
        "--to",
        "@reviewer",
        "--agent-network",
        agent_network_id,
        "Review this",
      ],
      { from: "user" },
    );
    assert.equal(resolved, 1);
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].target, target);
    assert.equal(attempts[0].action, "send");
    assert.equal(attempts[0].body, "Review this");
    assert.equal(output.outcome, "accepted");
    const [event] = parseAgentMessageRuntimeEvents(stderr);
    assert.equal(event.target_name, "reviewer");
    assert.equal(event.body, "Review this");
    assert.equal(event.outcome, "accepted");
    await assert.rejects(
      program.parseAsync(
        [
          "project",
          "chat",
          "send",
          "--to",
          "@reviewer",
          "--to-agent",
          target.agent_id,
          "Review this",
        ],
        { from: "user" },
      ),
    );
    assert.equal(attempts.length, 1);
  } finally {
    process.exitCode = oldExit;
    if (oldAgentMode == null) delete process.env.COCALC_CLI_AGENT_MODE;
    else process.env.COCALC_CLI_AGENT_MODE = oldAgentMode;
    if (oldChatPath == null) delete process.env.COCALC_CODEX_CHAT_PATH;
    else process.env.COCALC_CODEX_CHAT_PATH = oldChatPath;
    if (oldThreadId == null) delete process.env.COCALC_CODEX_THREAD_ID;
    else process.env.COCALC_CODEX_THREAD_ID = oldThreadId;
    stderrWrite.mock.restore();
    resolver.mock.restore();
    transport.mock.restore();
  }
});

test("attachment sends preserve same-project references and prepare cross-project bytes", async () => {
  const target = { project_id: randomUUID(), agent_id: randomUUID() };
  const agent_network_id = randomUUID();
  const paths = [
    { kind: "project-file", path: "/tmp/report.pdf" },
    { kind: "project-file", path: "/tmp/results.json" },
  ];
  const calls: any[] = [];
  const resolver = mock.method(
    require("../../core/agent-destination"),
    "resolveRuntimeAgentName",
    async () => ({ target, agent_network_id }),
  );
  const reader = mock.method(
    require("../../core/agent-attachments"),
    "readAgentFileReferences",
    async (input: string[]) => {
      assert.deepEqual(input, ["report.pdf", "results.json"]);
      return { kind: "project-files", files: paths };
    },
  );
  let sourceProject = target.project_id;
  let allowPreparation = true;
  const data = Buffer.from([0, 128, 255]);
  const snapshot = {
    name: "report.pdf",
    size: data.length,
    sha256: "a".repeat(64),
  };
  const snapshotReader = mock.method(
    require("../../core/agent-attachments"),
    "readAgentAttachmentSnapshots",
    async () => ({
      metadata: { kind: "snapshots", files: [snapshot] },
      files: [{ ...snapshot, data }],
    }),
  );
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: any) => {
      calls.push(request);
      if (request.action === "whoami")
        return { identity: { project_id: sourceProject } };
      if (request.action === "prepare-attachments")
        return allowPreparation
          ? {
              version: 3,
              agent_network_id,
              target,
              attempt_id: request.attempt_id,
              outcome: "prepared",
              reservation_id: randomUUID(),
              expires_at: Date.now() + 30_000,
            }
          : {
              version: 3,
              agent_network_id,
              target,
              attempt_id: request.attempt_id,
              outcome: "rejected",
              observed_at: Date.now(),
              reason: "autostart disabled",
            };
      return { ...request, outcome: "accepted", observed_at: Date.now() };
    },
  );
  const program = new Command();
  registerProjectChatCommands(program.command("project"), {
    globalsFrom: () => ({}),
    emitSuccess: () => {},
    withContext: () => {
      throw Error("broad auth fallback");
    },
  } as any);
  const oldExit = process.exitCode;
  const args = [
    "project",
    "chat",
    "send",
    "--to",
    "reviewer",
    "--agent-network",
    agent_network_id,
    "--attach",
    "report.pdf",
    "--attach",
    "results.json",
    "Review these",
  ];
  try {
    await program.parseAsync(args, { from: "user" });
    assert.deepEqual(
      calls.map((c) => c.action),
      ["whoami", "send"],
    );
    assert.deepEqual(calls[1].file_references, paths);
    sourceProject = randomUUID();
    await program.parseAsync(args, { from: "user" });
    assert.deepEqual(
      calls.map((c) => c.action),
      ["whoami", "send", "whoami", "prepare-attachments", "send"],
    );
    assert.equal(calls[3].snapshot_payload, undefined);
    assert.deepEqual(calls[4].snapshot_payload[0].data, data);
    assert.ok(calls[4].attachment_reservation);
    allowPreparation = false;
    await program.parseAsync(args, { from: "user" });
    assert.equal(calls.at(-1).action, "prepare-attachments");
    assert.equal(calls.filter((r) => r.action === "send").length, 2);
    assert.equal(process.exitCode, 2);
    assert.equal(reader.mock.callCount(), 1);
  } finally {
    process.exitCode = oldExit;
    resolver.mock.restore();
    reader.mock.restore();
    snapshotReader.mock.restore();
    transport.mock.restore();
  }
});

function setup() {
  const program = new Command();
  program.exitOverride();
  const project = program.command("project");
  const calls: any[] = [];
  let output: any;
  const ctx = {
    accountId: "actor",
    hub: { agent: {} },
  };
  registerProjectChatCommands(project, {
    withContext: async (
      _command: Command,
      _name: string,
      action: (ctx: any) => unknown,
    ) => {
      output = await action(ctx);
    },
    readAllStdin: async () => '{"message":"hello"}\n',
    projectChatSendData: async (options: unknown) => {
      calls.push(options);
      return { state: "accepted" };
    },
    projectChatThreadStatusData: async (options: unknown) => {
      calls.push(options);
      return {
        path: "test.chat",
        threads: [
          {
            thread_id: "one",
            name: "Reviewer",
            agent_kind: "acp",
            archived: false,
            acp_config: { sessionId: "runtime-session" },
          },
        ],
      };
    },
  } as unknown as ProjectCommandDeps);
  return { program, calls, ctx, output: () => output };
}

async function withoutRuntimeIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.COCALC_AGENT_IDENTITY_FILE;
  delete process.env.COCALC_AGENT_IDENTITY_FILE;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.COCALC_AGENT_IDENTITY_FILE;
    else process.env.COCALC_AGENT_IDENTITY_FILE = previous;
  }
}

test("chat send targets the exact project/path/thread and defaults to queued delivery", async () => {
  const f = setup();
  await withoutRuntimeIdentity(() =>
    f.program.parseAsync(
      [
        "project",
        "chat",
        "send",
        "--project",
        "target",
        "--path",
        "test.chat",
        "--thread-id",
        "one",
        "Please",
        "review",
      ],
      { from: "user" },
    ),
  );
  assert.deepEqual(f.calls, [
    {
      ctx: f.ctx,
      projectIdentifier: "target",
      path: "test.chat",
      threadId: "one",
      prompt: "Please review",
      guidance: undefined,
    },
  ]);
  assert.equal(f.output().state, "accepted");
});

test("chat send --stdin --guidance preserves JSON and newlines", async () => {
  const f = setup();
  await withoutRuntimeIdentity(() =>
    f.program.parseAsync(
      [
        "project",
        "chat",
        "send",
        "--path",
        "test.chat",
        "--thread-id",
        "one",
        "--stdin",
        "--guidance",
      ],
      { from: "user" },
    ),
  );
  assert.equal(f.calls[0].prompt, '{"message":"hello"}\n');
  assert.equal(f.calls[0].guidance, true);
});

test("chat send rejects ambiguous or empty input before connecting", async () => {
  for (const message of [[], ["--stdin", "also text"]]) {
    const f = setup();
    await assert.rejects(
      withoutRuntimeIdentity(() =>
        f.program.parseAsync(
          [
            "project",
            "chat",
            "send",
            "--path",
            "test.chat",
            "--thread-id",
            "one",
            ...message,
          ],
          { from: "user" },
        ),
      ),
      /empty|either/,
    );
    assert.equal(f.calls.length, 0);
  }
});

test("thread list shows chat IDs and names without dumping session configuration", async () => {
  const f = setup();
  await f.program.parseAsync(
    ["project", "chat", "thread", "list", "--path", "test.chat"],
    { from: "user" },
  );
  assert.deepEqual(f.output(), [
    {
      thread_id: "one",
      name: "Reviewer",
      agent_kind: "acp",
      archived: false,
    },
  ]);
});
