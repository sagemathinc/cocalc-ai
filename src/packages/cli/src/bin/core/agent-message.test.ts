import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sendIdentityMessage,
  validateIdentityCredential,
} from "./agent-message";

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
