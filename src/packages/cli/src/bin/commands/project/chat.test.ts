import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import type { ProjectCommandDeps } from "../project";
import { registerProjectChatCommands } from "./chat";

function setup() {
  const program = new Command();
  program.exitOverride();
  const project = program.command("project");
  const calls: any[] = [];
  let output: any;
  const ctx = { accountId: "actor" };
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
