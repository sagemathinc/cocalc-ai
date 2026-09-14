import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTurnAgentReferences } from "./agent-destination";
import type { AgentRpcSend } from "@cocalc/conat/agents/rpc";
import {
  sendIdentityMessage,
  validateIdentityCredential,
} from "./agent-message";

test("retired delivery fails locally before credential lookup or network access", async () => {
  await assert.rejects(
    sendIdentityMessage({
      action: "send",
      request_id: randomUUID(),
      target_agent_id: randomUUID(),
      body: "Do not submit this legacy request",
    }),
    /retired/,
  );
});

test("missing identity never falls back to an available broad credential", async () => {
  const old = process.env.COCALC_AGENT_IDENTITY_FILE;
  delete process.env.COCALC_AGENT_IDENTITY_FILE;
  try {
    await assert.rejects(
      sendIdentityMessage({ action: "receipt", request_id: randomUUID() }),
      /runtime-issued/,
    );
    process.env.COCALC_AGENT_IDENTITY_FILE =
      "/nonexistent/cocalc-test-identity";
    await assert.rejects(
      sendIdentityMessage({ action: "receipt", request_id: randomUUID() }),
      /no account\/project fallback/,
    );
  } finally {
    if (old === undefined) delete process.env.COCALC_AGENT_IDENTITY_FILE;
    else process.env.COCALC_AGENT_IDENTITY_FILE = old;
  }
});
test("expired and malformed identity bundles fail closed", () => {
  const credential = {
    agent_id: randomUUID(),
    run_id: randomUUID(),
    token: "cocalc_agent_identity_test",
    expires_at: Date.now() + 60000,
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

test("RPC CLI makes one scoped request and preserves honest outcomes", async () => {
  const conat = require("@cocalc/conat/core/client");
  const dir = await mkdtemp(join(tmpdir(), "agent-rpc-cli-"));
  const old = process.env.COCALC_AGENT_IDENTITY_FILE;
  const credential = {
    agent_id: randomUUID(),
    run_id: randomUUID(),
    token: "cocalc_agent_identity_test",
    expires_at: Date.now() + 60000,
    api_url: "https://owner.invalid",
  };
  const request: AgentRpcSend & { action: "send" } = {
    version: 2,
    action: "send",
    attempt_id: randomUUID(),
    target: { agent_id: randomUUID(), project_id: randomUUID() },
    body: "test",
  };
  let calls = 0;
  let closes = 0;
  let response: unknown;
  let lost = false;
  let hang = false;
  const stub = mock.method(conat, "connect", (options: any) => {
    assert.equal(options.address, credential.api_url);
    assert.deepEqual(options.auth, { bearer: credential.token });
    assert.equal(options.rejectUnauthorized, true);
    return {
      request: async (_subject: string, body: unknown, opts: any) => {
        calls++;
        assert.deepEqual(body, request);
        assert.equal(opts.waitForInterest, false);
        assert.equal(opts.timeout, 50000);
        if (hang) return new Promise(() => {});
        if (lost) throw new Error("acknowledgment lost");
        return { data: { result: response } };
      },
      close: () => closes++,
    };
  });
  try {
    process.env.COCALC_AGENT_IDENTITY_FILE = join(dir, "identity.json");
    await writeFile(
      process.env.COCALC_AGENT_IDENTITY_FILE,
      JSON.stringify(credential),
      { mode: 0o600 },
    );
    for (const outcome of ["accepted", "rejected", "unknown"] as const) {
      response = {
        version: 2,
        target: request.target,
        attempt_id: request.attempt_id,
        outcome,
        observed_at: Date.now(),
      };
      assert.deepEqual(await sendIdentityMessage(request), response);
    }
    for (const result of [
      null,
      { ...(response as object), attempt_id: randomUUID() },
    ]) {
      response = result;
      const receipt: any = await sendIdentityMessage(request);
      assert.equal(receipt.outcome, "unknown");
      assert.equal(receipt.attempt_id, request.attempt_id);
    }
    lost = true;
    const receipt: any = await sendIdentityMessage(request);
    assert.equal(receipt.outcome, "unknown");
    assert.deepEqual(receipt.target, request.target);
    assert.equal(receipt.attempt_id, request.attempt_id);
    assert.equal(calls, 6);
    assert.equal(closes, calls);
    const originalTimer = globalThis.setTimeout;
    const timer = mock.method(globalThis, "setTimeout", ((
      fn: any,
      ms: number,
      ...args: any[]
    ) =>
      originalTimer(fn, ms === 50000 ? 1 : ms, ...args)) as typeof setTimeout);
    try {
      hang = true;
      const timedOut: any = await sendIdentityMessage(request);
      assert.equal(timedOut.outcome, "unknown");
      assert.equal(timedOut.attempt_id, request.attempt_id);
      assert.equal(calls, 7);
      assert.equal(closes, calls);
    } finally {
      timer.mock.restore();
    }
  } finally {
    stub.mock.restore();
    if (old === undefined) delete process.env.COCALC_AGENT_IDENTITY_FILE;
    else process.env.COCALC_AGENT_IDENTITY_FILE = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval requests and turn references stay bound to the current credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-personal-cli-"));
  const old = process.env.COCALC_AGENT_IDENTITY_FILE;
  const oldRefs = process.env.COCALC_AGENT_MENTION_REFERENCES_FILE;
  const credential = {
    agent_id: randomUUID(),
    run_id: randomUUID(),
    token: "cocalc_agent_identity_test",
    expires_at: Date.now() + 60000,
    api_url: "https://owner.invalid",
  };
  const request = {
    version: 2 as const,
    action: "request-connection" as const,
    request_id: randomUUID(),
    target: { agent_id: randomUUID(), project_id: randomUUID() },
    reason: "review",
    ttl_seconds: null,
  };
  let result: any = {
    ...request,
    source: { agent_id: credential.agent_id, project_id: randomUUID() },
    run_id: credential.run_id,
    state: "pending",
  };
  let calls = 0;
  let closes = 0;
  const stub = mock.method(
    require("@cocalc/conat/core/client"),
    "connect",
    () => ({
      request: async () => {
        calls++;
        if (result === null) throw new Error("lost approval acknowledgment");
        return { data: { result } };
      },
      close: () => closes++,
    }),
  );
  try {
    process.env.COCALC_AGENT_IDENTITY_FILE = join(dir, "identity.json");
    process.env.COCALC_AGENT_MENTION_REFERENCES_FILE = join(
      dir,
      "references.json",
    );
    await writeFile(
      process.env.COCALC_AGENT_IDENTITY_FILE,
      JSON.stringify(credential),
    );
    const references = [{ name: "reviewer", target: request.target }];
    await writeFile(
      process.env.COCALC_AGENT_MENTION_REFERENCES_FILE,
      JSON.stringify({
        agent_id: credential.agent_id,
        run_id: credential.run_id,
        references,
      }),
    );
    assert.deepEqual(await readTurnAgentReferences(), references);
    assert.equal((await sendIdentityMessage(request)).state, "pending");
    result = { ...result, request_id: randomUUID() };
    assert.equal(
      (await sendIdentityMessage(request)).request_id,
      result.request_id,
    );
    result = { ...result, run_id: randomUUID() };
    await assert.rejects(sendIdentityMessage(request), /mismatched/);
    result = null;
    await assert.rejects(
      sendIdentityMessage(request),
      /lost approval acknowledgment/,
    );
    assert.equal(calls, 4);
    assert.equal(closes, 4);
    await writeFile(
      process.env.COCALC_AGENT_IDENTITY_FILE,
      JSON.stringify({ ...credential, run_id: randomUUID() }),
    );
    await assert.rejects(readTurnAgentReferences(), /current|match|invalid/i);
  } finally {
    stub.mock.restore();
    if (old === undefined) delete process.env.COCALC_AGENT_IDENTITY_FILE;
    else process.env.COCALC_AGENT_IDENTITY_FILE = old;
    if (oldRefs === undefined)
      delete process.env.COCALC_AGENT_MENTION_REFERENCES_FILE;
    else process.env.COCALC_AGENT_MENTION_REFERENCES_FILE = oldRefs;
    await rm(dir, { recursive: true, force: true });
  }
});
