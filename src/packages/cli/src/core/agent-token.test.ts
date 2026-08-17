import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentTokenFromEnv } from "./agent-token";

test("resolveAgentTokenFromEnv prefers and re-reads a rotating token file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-agent-token-"));
  try {
    const tokenFile = join(dir, "token");
    const env = {
      COCALC_BEARER_TOKEN_FILE: tokenFile,
      COCALC_BEARER_TOKEN: "stale-inline-token",
    };
    writeFileSync(tokenFile, "first-token\n");
    assert.equal(resolveAgentTokenFromEnv(env), "first-token");

    writeFileSync(tokenFile, "second-token\n");
    assert.equal(resolveAgentTokenFromEnv(env), "second-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAgentTokenFromEnv falls back to inline agent auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-agent-token-"));
  try {
    assert.equal(
      resolveAgentTokenFromEnv({
        COCALC_AGENT_TOKEN_FILE: join(dir, "missing"),
        COCALC_AGENT_TOKEN: "inline-agent-token",
      }),
      "inline-agent-token",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
