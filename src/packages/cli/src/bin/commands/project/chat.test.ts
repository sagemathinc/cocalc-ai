import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import type { ProjectCommandDeps } from "../project";
import { registerProjectChatCommands } from "./chat";

test("named send uses one scoped attempt and never the human send path", async () => {
  const target = { project_id: randomUUID(), agent_id: randomUUID() };
  let resolved = 0;
  const attempts: any[] = [];
  let output: any;
  const resolver = mock.method(
    require("../../core/agent-destination"),
    "resolveRuntimeAgentName",
    async (name: string) => {
      assert.equal(name, "@reviewer");
      resolved++;
      return target;
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
  try {
    await program.parseAsync(
      ["project", "chat", "send", "--to", "@reviewer", "Review this"],
      { from: "user" },
    );
    assert.equal(resolved, 1);
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].target, target);
    assert.equal(attempts[0].action, "send");
    assert.equal(attempts[0].body, "Review this");
    assert.equal(output.outcome, "accepted");
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
    resolver.mock.restore();
    transport.mock.restore();
  }
});

test("same-project attachment send uses trusted identity and preserves selected paths", async () => {
  const target = { project_id: randomUUID(), agent_id: randomUUID() };
  const paths = [
    { kind: "project-file", path: "/tmp/report.pdf" },
    { kind: "project-file", path: "/tmp/results.json" },
  ];
  const calls: any[] = [];
  const resolver = mock.method(
    require("../../core/agent-destination"),
    "resolveRuntimeAgentName",
    async () => target,
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
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: any) => {
      calls.push(request);
      if (request.action === "whoami")
        return { identity: { project_id: sourceProject } };
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
    await assert.rejects(
      program.parseAsync(args, { from: "user" }),
      /Cross-project attachments are not yet enabled/,
    );
    assert.deepEqual(
      calls.map((c) => c.action),
      ["whoami", "send", "whoami"],
    );
    assert.equal(reader.mock.callCount(), 1);
  } finally {
    process.exitCode = oldExit;
    resolver.mock.restore();
    reader.mock.restore();
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
    hub: {
      agent: {
        listMessageReceipts: async (options: unknown) => {
          calls.push(options);
          return { items: [] };
        },
      },
    },
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

test("chat send targets the exact project/path/thread and defaults to queued delivery", async () => {
  const f = setup();
  await f.program.parseAsync(
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

test("human receipt inspection forwards only the chosen endpoint and page", async () => {
  const f = setup();
  await f.program.parseAsync(
    [
      "project",
      "chat",
      "agent",
      "receipts",
      "source",
      "--limit",
      "7",
      "--cursor",
      "cursor",
    ],
    { from: "user" },
  );
  assert.deepEqual(f.calls, [
    { agent_id: "source", project_id: undefined, limit: 7, cursor: "cursor" },
  ]);
  assert.deepEqual(f.output(), { items: [] });
});

test("chat send --stdin --guidance preserves JSON and newlines", async () => {
  const f = setup();
  await f.program.parseAsync(
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
  );
  assert.equal(f.calls[0].prompt, '{"message":"hello"}\n');
  assert.equal(f.calls[0].guidance, true);
});

test("chat send rejects ambiguous or empty input before connecting", async () => {
  for (const message of [[], ["--stdin", "also text"]]) {
    const f = setup();
    await assert.rejects(
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
