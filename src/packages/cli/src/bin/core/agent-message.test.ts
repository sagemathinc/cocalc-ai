import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { rpcOutcome, type AgentRpcSend } from "@cocalc/conat/agents/rpc";
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
