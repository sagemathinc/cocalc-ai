import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { registerChatAgentCommands } from "./chat-agents";

test("RPC approval uses directional endpoints and bounded expiry without legacy APIs", async () => {
  const calls: any[] = [];
  const program = new Command();
  registerChatAgentCommands(program.command("chat"), {
    withContext: async (_cmd, name, fn) =>
      fn({
        hub: {
          agent: {
            grantRpcLink: async (opts) => {
              calls.push({ name, opts });
            },
            revokeRpcLink: async (opts) => {
              calls.push({ name, opts });
            },
          },
        },
      }),
  } as any);
  await program.parseAsync([
    "node",
    "test",
    "chat",
    "agent",
    "rpc",
    "link",
    "source",
    "target",
    "--source-project",
    "source-project",
    "--target-project",
    "target-project",
    "--reason",
    "review",
    "--ttl-seconds",
    "3600",
  ]);
  assert.deepEqual(calls[0].opts.source, {
    project_id: "source-project",
    agent_id: "source",
  });
  assert.deepEqual(calls[0].opts.target, {
    project_id: "target-project",
    agent_id: "target",
  });
  assert.equal(calls[0].opts.allow_guidance, false);
  assert.equal(calls[0].opts.ttl_seconds, 3600);
  assert.match(calls[0].opts.link_id, /^[a-f0-9-]{36}$/);
  await program.parseAsync([
    "node",
    "test",
    "chat",
    "agent",
    "rpc",
    "revoke",
    calls[0].opts.link_id,
    "--source-agent",
    "source",
    "--source-project",
    "source-project",
  ]);
  assert.deepEqual(calls[1].opts, {
    source: { project_id: "source-project", agent_id: "source" },
    link_id: calls[0].opts.link_id,
  });
});

for (const [command, method] of [
  ["links", "listGrants"],
  ["receipts", "listMessageReceipts"],
] as const) {
  for (const qualified of [false, true]) {
    test(`${command} ${qualified ? "routes an explicit project" : "keeps legacy bay-local scope"}`, async () => {
      let captured: unknown;
      let resolved = 0;
      const program = new Command();
      registerChatAgentCommands(program.command("chat"), {
        withContext: async (_cmd, _name, fn) =>
          fn({
            hub: {
              agent: {
                [method]: async (opts) => {
                  captured = opts;
                  return { items: [] };
                },
              },
            },
          }),
        resolveProjectFromArgOrContext: async (_ctx, project) => {
          resolved++;
          assert.equal(project, "endpoint-project");
          return { project_id: "resolved-project" };
        },
      } as any);
      await program.parseAsync([
        "node",
        "test",
        "chat",
        "agent",
        command,
        "agent-id",
        "--limit",
        "5",
        "--cursor",
        "next-page",
        ...(qualified ? ["--project", "endpoint-project"] : []),
      ]);
      assert.deepEqual(captured, {
        agent_id: "agent-id",
        project_id: qualified ? "resolved-project" : undefined,
        limit: 5,
        cursor: "next-page",
      });
      assert.equal(resolved, qualified ? 1 : 0);
    });
  }
}
