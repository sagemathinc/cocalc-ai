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

test("session send uses one scoped request and reports a lost result as unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-session-cli-"));
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
    agent_session_id: randomUUID(),
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
