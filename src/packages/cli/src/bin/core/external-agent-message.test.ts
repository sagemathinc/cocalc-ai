import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import { rpcOutcome, type AgentRpcSend } from "@cocalc/conat/agents/rpc";
import {
  resolveExternalAgentNameIn,
  sendExternalAgentMessage,
} from "./external-agent-message";

test("external transport pins profile and preserves network send semantics", async () => {
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
    agent_network_id: randomUUID(),
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
    // A lost answer to a withdraw: it may have been withdrawn.
    const { body: _, ...attempt } = request;
    const withdrawn = (await sendExternalAgentMessage("security", {
      ...attempt,
      action: "withdraw",
    } as any)) as any;
    assert.equal(withdrawn.outcome, "unknown");
    assert.match(withdrawn.reason, /whether it was withdrawn/);
  } finally {
    connect.mock.restore();
    profile.mock.restore();
  }
});

test("an external agent sends to every name destinations shows it", () => {
  const network = (title: string) => ({
    agent_network_id: randomUUID(),
    title,
    delivery_mode: "live" as const,
    generation: randomUUID(),
  });
  const cocalc = network("cocalc");
  const other = network("other");
  const registered = { project_id: randomUUID(), agent_id: randomUUID() };
  const externalId = randomUUID();
  const external = {
    kind: "external" as const,
    account_id: randomUUID(),
    agent_id: externalId,
    installation_id: randomUUID(),
  };
  const added_at = new Date().toISOString();
  const directory = {
    peers: [
      {
        member: {
          kind: "registered" as const,
          member_id: registered.agent_id,
          endpoint: registered,
          name: "reviewer",
          available: true,
          added_at,
        },
        networks: [cocalc],
      },
      {
        member: {
          kind: "external" as const,
          member_id: externalId,
          source: external,
          label: "ops0 on alpha.cocalc.ai (ops project)",
          available: true,
          added_at,
        },
        networks: [cocalc],
      },
    ],
  };
  assert.deepEqual(
    resolveExternalAgentNameIn(directory, "reviewer").target,
    registered,
  );
  for (const name of [
    "ops0",
    "@ops0",
    externalId,
    "ops0 on alpha.cocalc.ai (ops project)",
  ])
    assert.deepEqual(
      resolveExternalAgentNameIn(directory, name, "cocalc").target,
      external,
      name,
    );
  // Only peers in the requested network.
  assert.throws(
    () => resolveExternalAgentNameIn(directory, "ops0", other.title),
    /No approved destination/,
  );
});
