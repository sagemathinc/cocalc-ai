import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { registerProjectChatCommands } from "./chat";

test("publish source uses turn context and explicit arguments override stale environment", async () => {
  const keys = [
    "COCALC_WORKBENCH",
    "COCALC_CODEX_CHAT_PATH",
    "COCALC_CODEX_THREAD_ID",
    "COCALC_CODEX_MESSAGE_DATE",
  ];
  const previous = keys.map((key) => process.env[key]);
  try {
    Object.assign(process.env, {
      COCALC_WORKBENCH: "1",
      COCALC_CODEX_CHAT_PATH: "/old.chat",
      COCALC_CODEX_THREAD_ID: "old-thread",
      COCALC_CODEX_MESSAGE_DATE: "old-date",
    });
    let result: any;
    const root = new Command();
    registerProjectChatCommands(root.command("project"), {
      withContext: async (_command: any, _name: any, fn: any) => fn({}),
      projectChatArtifactData: async (args: any) => {
        result = args;
      },
    } as any);
    await root.parseAsync(
      [
        "project",
        "chat",
        "artifact",
        "publish",
        "--source",
        "/plan.md",
        "--path",
        "/current.chat",
        "--thread-id",
        "current",
        "--message-date",
        "current-date",
      ],
      { from: "user" },
    );
    assert.equal(result.path, "/current.chat");
    assert.equal(result.threadId, "current");
    assert.equal(result.messageDate, "current-date");
    assert.deepEqual(result.payload, {
      title: "plan.md",
      file: { path: "/plan.md" },
    });
    assert.equal(result.action, "publish");
    process.env.COCALC_WORKBENCH = "0";
    await assert.rejects(
      root.parseAsync(
        ["project", "chat", "artifact", "publish", "--source", "/plan.md"],
        { from: "user" },
      ),
      /workbench-enabled/,
    );
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});
