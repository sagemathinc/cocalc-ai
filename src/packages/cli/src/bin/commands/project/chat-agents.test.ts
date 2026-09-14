import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { registerChatAgentCommands } from "./chat-agents";

test("personal approval command only requests permission and inspection never sends", async () => {
  const target = { agent_id: randomUUID(), project_id: randomUUID() };
  const request_id = randomUUID();
  const calls: any[] = [];
  const resolver = mock.method(
    require("../../core/agent-destination"),
    "resolveRuntimeAgentName",
    async () => target,
  );
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: any) => {
      calls.push(request);
      return { request_id, state: "pending" };
    },
  );
  const program = new Command();
  registerChatAgentCommands(program.command("chat"), {
    globalsFrom: () => ({}),
    emitSuccess: () => {},
    withContext: () => {
      throw new Error("human auth path must not be used");
    },
  } as any);
  try {
    await program.parseAsync(
      [
        "chat",
        "agent",
        "request-connection",
        "--to",
        "reviewer",
        "--request-id",
        request_id,
        "--reason",
        "review",
        "--never-expires",
        "--both-directions",
        "--wait-seconds",
        "0",
      ],
      { from: "user" },
    );
    assert.deepEqual(calls, [
      {
        version: 2,
        action: "request-connection",
        target,
        request_id,
        reason: "review",
        ttl_seconds: null,
        both_directions: true,
      },
    ]);
    await program.parseAsync(
      ["chat", "agent", "connection-request", request_id],
      { from: "user" },
    );
    assert.deepEqual(calls[1], {
      version: 2,
      action: "connection-request",
      request_id,
    });
    await assert.rejects(
      program.parseAsync(
        [
          "chat",
          "agent",
          "request-connection",
          "--to",
          "reviewer",
          "--reason",
          "review",
          "--never-expires",
          "--ttl-seconds",
          "60",
        ],
        { from: "user" },
      ),
      /not both/,
    );
    assert.equal(calls.length, 2);
  } finally {
    resolver.mock.restore();
    transport.mock.restore();
  }
});

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

test("waiting for approval polls inspection only and returns the decision without sending", async () => {
  const target = { agent_id: randomUUID(), project_id: randomUUID() };
  const request_id = randomUUID();
  const actions: string[] = [];
  let result: any;
  const transport = mock.method(
    require("../../core/agent-message"),
    "sendIdentityMessage",
    async (request: any) => {
      actions.push(request.action);
      return {
        request_id,
        state: request.action === "request-connection" ? "pending" : "approved",
      };
    },
  );
  const setTimeoutOriginal = globalThis.setTimeout;
  const timer = mock.method(globalThis, "setTimeout", ((
    fn: any,
    ms: number,
    ...args: any[]
  ) =>
    setTimeoutOriginal(
      fn,
      ms === 2000 ? 1 : ms,
      ...args,
    )) as typeof setTimeout);
  const program = new Command();
  registerChatAgentCommands(program.command("chat"), {
    globalsFrom: () => ({}),
    emitSuccess: (_ctx: any, _name: any, value: any) => {
      result = value;
    },
    withContext: () => {
      throw new Error("broad auth fallback");
    },
  } as any);
  try {
    await program.parseAsync(
      [
        "chat",
        "agent",
        "request-connection",
        "--to-agent",
        target.agent_id,
        "--target-project",
        target.project_id,
        "--request-id",
        request_id,
        "--reason",
        "review",
      ],
      { from: "user" },
    );
    assert.deepEqual(actions, ["request-connection", "connection-request"]);
    assert.equal(result.state, "approved");
  } finally {
    transport.mock.restore();
    timer.mock.restore();
  }
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
