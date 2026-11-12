import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import {
  AGENT_RPC_ADMISSION_CAPACITY_CODE,
  AGENT_RPC_ADMISSION_CAPACITY_MESSAGE,
  agentRpcRetryable,
  isAgentRpcAdmissionCapacityResponse,
  rpcOutcome,
  type AgentRpcOutcome,
  type AgentRpcSend,
} from "@cocalc/conat/agents/rpc";
import {
  sendIdentityMessage,
  validateIdentityCredential,
} from "./agent-message";

test("runtime identity credentials are explicit and finite", () => {
  const credential = {
    agent_id: randomUUID(),
    run_id: randomUUID(),
    token: "cocalc_agent_identity_test",
    expires_at: Date.now() + 60_000,
  };
  assert.doesNotThrow(() => validateIdentityCredential(credential));
  assert.throws(
    () => validateIdentityCredential({ ...credential, expires_at: 0 }),
    /expired/,
  );
  assert.throws(
    () => validateIdentityCredential({ ...credential, token: "project-token" }),
    /invalid/,
  );
});

test("missing identity never falls back to account or project credentials", async () => {
  const previous = process.env.COCALC_AGENT_IDENTITY_FILE;
  delete process.env.COCALC_AGENT_IDENTITY_FILE;
  try {
    await assert.rejects(
      sendIdentityMessage({ version: 3, action: "destinations" }),
      /runtime-issued/,
    );
  } finally {
    if (previous === undefined) delete process.env.COCALC_AGENT_IDENTITY_FILE;
    else process.env.COCALC_AGENT_IDENTITY_FILE = previous;
  }
});

test("agent selection never sends a pinned identity token outside its site, even through a positive relay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-route-scope-"));
  const saved = { ...process.env };
  const fetchStub = mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  const connectStub = mock.method(
    require("@cocalc/conat/core/client"),
    "connect",
    () => {
      throw Error("must not connect to overridden site");
    },
  );
  try {
    Object.assign(process.env, {
      COCALC_AGENT_IDENTITY_FILE: join(dir, "identity.json"),
      COCALC_API_RELAY: "1",
      COCALC_API_RELAY_HUB_URL: "https://owner.invalid",
      COCALC_PROJECT_ID: randomUUID(),
      COCALC_PROJECT_SECRET: "local-fixture-secret",
      CONAT_SERVER: "http://127.0.0.1:9102",
    });
    await writeFile(
      process.env.COCALC_AGENT_IDENTITY_FILE!,
      JSON.stringify({
        agent_id: randomUUID(),
        run_id: randomUUID(),
        token: "cocalc_agent_identity_fixture",
        expires_at: Date.now() + 60_000,
        api_url: "https://owner.invalid",
      }),
      { mode: 0o600 },
    );
    for (const mode of ["auto", "direct", "relay"]) {
      process.env.COCALC_CLI_TRANSPORT = mode;
      // Same-site relay shortcut, successful probe, and forced relay must all
      // honor the identity's pin, not merely the environment's relay site.
      for (const relaySite of [
        "https://owner.invalid",
        "https://unrelated.invalid",
      ]) {
        process.env.COCALC_API_RELAY_HUB_URL = relaySite;
        await assert.rejects(
          sendIdentityMessage(
            { version: 3, action: "destinations" },
            "https://unrelated.invalid",
          ),
          /destination-scoped/,
        );
      }
    }
    assert.equal(connectStub.mock.callCount(), 0);
    assert.equal(fetchStub.mock.callCount(), 0);
  } finally {
    fetchStub.mock.restore();
    connectStub.mock.restore();
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test("production-shaped identity without api_url is bound to the runtime site, not an override or relay allowlist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-site-"));
  const saved = { ...process.env };
  const credential = {
    agent_id: randomUUID(),
    run_id: randomUUID(),
    token: "cocalc_agent_identity_runtime_fixture",
    expires_at: Date.now() + 60_000,
  };
  const fetchStub = mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  const connectStub = mock.method(
    require("@cocalc/conat/core/client"),
    "connect",
    (options: any) => {
      assert.deepEqual(options.auth, { bearer: credential.token });
      return {
        request: async () => ({ data: { result: { peers: [] } } }),
        close: () => {},
      };
    },
  );
  try {
    Object.assign(process.env, {
      COCALC_AGENT_IDENTITY_FILE: join(dir, "identity.json"),
      COCALC_API_URL: "https://runtime-owner.test",
      COCALC_API_RELAY: "1",
      COCALC_PROJECT_ID: randomUUID(),
      COCALC_PROJECT_SECRET: "fixture-local-secret",
      CONAT_SERVER: "http://127.0.0.1:9102",
    });
    await writeFile(
      process.env.COCALC_AGENT_IDENTITY_FILE!,
      JSON.stringify(credential),
      { mode: 0o600 },
    );
    for (const mode of ["auto", "relay", "direct"]) {
      process.env.COCALC_CLI_TRANSPORT = mode;
      for (const relaySite of [
        "https://runtime-owner.test",
        "https://other-bay.test",
      ]) {
        process.env.COCALC_API_RELAY_HUB_URL = relaySite;
        await assert.rejects(
          sendIdentityMessage(
            { version: 3, action: "destinations" },
            "https://other-bay.test",
          ),
          /destination-scoped/,
        );
      }
    }
    assert.equal(fetchStub.mock.callCount(), 0);
    assert.equal(connectStub.mock.callCount(), 0);

    // Missing trusted scope fails even if the override equals a relay site.
    delete process.env.COCALC_API_URL;
    for (const mode of ["auto", "relay", "direct"]) {
      process.env.COCALC_CLI_TRANSPORT = mode;
      await assert.rejects(
        sendIdentityMessage(
          { version: 3, action: "destinations" },
          "https://other-bay.test",
        ),
        /cannot establish credential scope/,
      );
    }
    assert.equal(fetchStub.mock.callCount(), 0);
    assert.equal(connectStub.mock.callCount(), 0);

    // Existing runtime-issued identities remain usable at their runtime site.
    process.env.COCALC_API_URL = "https://runtime-owner.test";
    process.env.COCALC_API_RELAY_HUB_URL = "https://runtime-owner.test";
    for (const mode of ["auto", "relay", "direct"]) {
      process.env.COCALC_CLI_TRANSPORT = mode;
      for (const override of [undefined, "https://runtime-owner.test/"]) {
        assert.deepEqual(
          await sendIdentityMessage(
            { version: 3, action: "destinations" },
            override,
          ),
          { peers: [] },
        );
      }
    }
    assert.equal(fetchStub.mock.callCount(), 0);
    assert.equal(connectStub.mock.callCount(), 6);
  } finally {
    fetchStub.mock.restore();
    connectStub.mock.restore();
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test("network send uses one scoped request and reports a lost result as unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-network-cli-"));
  const previous = process.env.COCALC_AGENT_IDENTITY_FILE;
  const credential = {
    agent_id: randomUUID(),
    run_id: randomUUID(),
    token: "cocalc_agent_identity_test",
    expires_at: Date.now() + 60_000,
    api_url: "https://owner.invalid",
  };
  const request: AgentRpcSend & { action: "send" } = {
    version: 3,
    action: "send",
    attempt_id: randomUUID(),
    agent_network_id: randomUUID(),
    target: { agent_id: randomUUID(), project_id: randomUUID() },
    body: "review this",
  };
  let lost = false;
  let calls = 0;
  const stub = mock.method(
    require("@cocalc/conat/core/client"),
    "connect",
    (options: any) => ({
      request: async (_subject: string, body: unknown, opts: any) => {
        calls++;
        assert.deepEqual(body, request);
        assert.equal(opts.waitForInterest, false);
        assert.deepEqual(options.auth, { bearer: credential.token });
        if (lost) throw new Error("acknowledgment lost");
        return { data: { result: rpcOutcome(request, "accepted") } };
      },
      close: () => {},
    }),
  );
  try {
    process.env.COCALC_AGENT_IDENTITY_FILE = join(dir, "identity.json");
    await writeFile(
      process.env.COCALC_AGENT_IDENTITY_FILE,
      JSON.stringify(credential),
      { mode: 0o600 },
    );
    assert.equal((await sendIdentityMessage(request)).outcome, "accepted");
    lost = true;
    assert.equal((await sendIdentityMessage(request)).outcome, "unknown");
    assert.equal(calls, 2);
  } finally {
    stub.mock.restore();
    if (previous === undefined) delete process.env.COCALC_AGENT_IDENTITY_FILE;
    else process.env.COCALC_AGENT_IDENTITY_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hub at admission capacity is a definite, retryable rejection, never unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-network-busy-"));
  const previous = process.env.COCALC_AGENT_IDENTITY_FILE;
  const credential = {
    agent_id: randomUUID(),
    run_id: randomUUID(),
    token: "cocalc_agent_identity_test",
    expires_at: Date.now() + 60_000,
    api_url: "https://owner.invalid",
  };
  const marker = `private-body-marker-${randomUUID()}`;
  const target = { agent_id: randomUUID(), project_id: randomUUID() };
  const send: AgentRpcSend & { action: "send" } = {
    version: 3,
    action: "send",
    attempt_id: randomUUID(),
    agent_network_id: randomUUID(),
    target,
    body: marker,
  };
  // The current hub sends a code; an older one only the fixed message.
  let reply: Record<string, string> = {
    error: AGENT_RPC_ADMISSION_CAPACITY_MESSAGE,
    code: AGENT_RPC_ADMISSION_CAPACITY_CODE,
  };
  let calls = 0;
  const stub = mock.method(
    require("@cocalc/conat/core/client"),
    "connect",
    () => ({
      request: async () => {
        calls++;
        return { data: reply };
      },
      close: () => {},
    }),
  );
  try {
    process.env.COCALC_AGENT_IDENTITY_FILE = join(dir, "identity.json");
    await writeFile(
      process.env.COCALC_AGENT_IDENTITY_FILE,
      JSON.stringify(credential),
      { mode: 0o600 },
    );
    for (const legacy of [false, true]) {
      if (legacy) reply = { error: AGENT_RPC_ADMISSION_CAPACITY_MESSAGE };
      const outcome = await sendIdentityMessage(send);
      assert.equal(outcome.outcome, "rejected");
      assert.equal(outcome.code, "rpc_admission_capacity");
      assert.equal(outcome.chat_effect, "none");
      assert.equal(outcome.attempt_id, send.attempt_id);
      assert.equal(agentRpcRetryable(outcome), true);
      assert.doesNotMatch(JSON.stringify(outcome), new RegExp(marker));
      // A broadcast never started: a coded error, safe to run again.
      const error: any = await sendIdentityMessage({
        version: 3,
        action: "broadcast",
        broadcast_id: randomUUID(),
        agent_network_id: send.agent_network_id,
        targets: [target],
        body: marker,
      }).then(
        () => assert.fail("a refused broadcast must not look delivered"),
        (error) => error,
      );
      assert.equal(error.code, "rpc_admission_capacity");
      assert.equal(error.retryable, true);
      assert.match(error.message, /^agent RPC admission capacity reached;/);
      assert.doesNotMatch(error.message, new RegExp(marker));
      // Inspect stays unknown: it says nothing about the original message.
      const inspected = (await sendIdentityMessage({
        version: 3,
        action: "inspect",
        attempt_id: send.attempt_id,
        agent_network_id: send.agent_network_id,
        target,
      } as any)) as unknown as AgentRpcOutcome;
      assert.equal(inspected.outcome, "unknown");
      assert.equal(agentRpcRetryable(inspected), false);
    }
    assert.equal(calls, 6);
  } finally {
    stub.mock.restore();
    if (previous === undefined) delete process.env.COCALC_AGENT_IDENTITY_FILE;
    else process.env.COCALC_AGENT_IDENTITY_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("only busy rejections that saved nothing are retryable", () => {
  const attempt = {
    version: 3 as const,
    attempt_id: randomUUID(),
    agent_network_id: randomUUID(),
    target: { agent_id: randomUUID(), project_id: randomUUID() },
  };
  const busy = [
    "host_overloaded",
    "project_overloaded",
    "rpc_admission_capacity",
  ];
  for (const code of busy)
    assert.equal(
      agentRpcRetryable(
        rpcOutcome(attempt, "rejected", {
          code: code as any,
          chat_effect: "none",
        }),
      ),
      true,
      code,
    );
  for (const outcome of [
    rpcOutcome(attempt, "accepted"),
    rpcOutcome(attempt, "unknown", { code: "host_overloaded" }),
    rpcOutcome(attempt, "rejected", { code: "host_overloaded" }),
    rpcOutcome(attempt, "rejected", {
      code: "host_overloaded",
      chat_effect: "saved",
    }),
    rpcOutcome(attempt, "rejected", {
      code: "host_overloaded",
      chat_effect: "unknown",
    }),
    rpcOutcome(attempt, "rejected", {
      code: "autostart_disabled",
      chat_effect: "none",
    }),
    rpcOutcome(attempt, "rejected", { chat_effect: "none" }),
  ])
    assert.equal(agentRpcRetryable(outcome), false, JSON.stringify(outcome));
  assert.equal(isAgentRpcAdmissionCapacityResponse({ error: "other" }), false);
  assert.equal(isAgentRpcAdmissionCapacityResponse(undefined), false);
});
