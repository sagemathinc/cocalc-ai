import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import { rpcOutcome, type AgentRpcSend } from "@cocalc/conat/agents/rpc";
import { sendExternalAgentMessage } from "./external-agent-message";

test("external transport pins profile and preserves session send semantics", async () => {
  const source = {
    kind: "external" as const,
    account_id: randomUUID(),
    installation_id: randomUUID(),
    agent_id: randomUUID(),
  };
  const credential = {
    source,
    token: "external-test-secret",
    api_url: "https://approved.example",
  };
  const profile = mock.method(
    require("./external-agent-profile"),
    "readExternalAgentCredential",
    () => credential,
  );
  const request: AgentRpcSend & { action: "send" } = {
    version: 3,
    action: "send",
    attempt_id: randomUUID(),
    agent_session_id: randomUUID(),
    target: { agent_id: randomUUID(), project_id: randomUUID() },
    body: "test",
  };
  let lost = false;
  const connect = mock.method(
    require("@cocalc/conat/core/client"),
    "connect",
    (opts: any) => {
      assert.equal(opts.address, credential.api_url);
      assert.deepEqual(opts.auth, { bearer: credential.token });
      const conn = new EventEmitter();
      return Object.assign(new EventEmitter(), {
        conn,
        isConnected: () => true,
        isSignedIn: () => true,
        request: async () => {
          if (lost) throw new Error("lost acknowledgment");
          return { data: { result: rpcOutcome(request, "accepted") } };
        },
        close: () => {},
      });
    },
  );
  try {
    assert.equal(
      ((await sendExternalAgentMessage("security", request)) as any).outcome,
      "accepted",
    );
    lost = true;
    assert.equal(
      ((await sendExternalAgentMessage("security", request)) as any).outcome,
      "unknown",
    );
  } finally {
    connect.mock.restore();
    profile.mock.restore();
  }
});
