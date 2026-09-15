import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { sendExternalAgentMessage } from "./external-agent-message";
import { rpcOutcome } from "@cocalc/conat/agents/rpc";

test("external transport pins credential/site, sends once, and reports lost acknowledgments as unknown", async () => {
  const source = {
    kind: "external",
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
    (name) => {
      assert.equal(name, "security");
      return credential;
    },
  );
  let lost = false,
    denied = false,
    calls = 0,
    closes = 0;
  const connect = mock.method(
    require("@cocalc/conat/core/client"),
    "connect",
    (opts) => {
      assert.equal(opts.address, credential.api_url);
      assert.equal(opts.reconnection, false);
      assert.deepEqual(opts.auth, { bearer: credential.token });
      assert.equal(
        opts.inboxPrefix,
        `_INBOX.agent-external.${source.account_id}.${source.installation_id}`,
      );
      const conn = new EventEmitter();
      const client = Object.assign(new EventEmitter(), {
        conn,
        isConnected: () => !denied,
        isSignedIn: () => !denied,
        request: async (subject, request, options) => {
          assert.equal(
            subject,
            `agent-external.${source.account_id}.${source.installation_id}`,
          );
          assert.equal(options.waitForInterest, false);
          calls++;
          if (lost) throw new Error("lost ack");
          return { data: { result: rpcOutcome(request, "accepted") } };
        },
        close: () => closes++,
      });
      if (denied)
        queueMicrotask(() =>
          conn.emit("connect_error", new Error("credential rejected")),
        );
      return client;
    },
  );
  const request = {
    version: 2 as const,
    action: "send" as const,
    attempt_id: randomUUID(),
    target: { agent_id: randomUUID(), project_id: randomUUID() },
    body: "test",
  };
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
    assert.equal(calls, 2);
    assert.equal(closes, 2);
    denied = true;
    assert.equal(
      ((await sendExternalAgentMessage("security", request)) as any).outcome,
      "rejected",
    );
    assert.equal(calls, 2, "failed authentication must not publish");
    assert.equal(closes, 3);
    await assert.rejects(
      sendExternalAgentMessage("security", {
        version: 2,
        action: "destinations",
      }),
      /sign-in failed; no submission/,
    );
    assert.equal(calls, 2);
    await assert.rejects(
      sendExternalAgentMessage("security", { ...request, guidance: true }),
      /guidance/,
    );
    profile.mock.mockImplementation(() => {
      throw new Error("expired external credential");
    });
    await assert.rejects(
      sendExternalAgentMessage("security", request),
      /expired/,
    );
    assert.equal(calls, 2);
  } finally {
    connect.mock.restore();
    profile.mock.restore();
  }
});
