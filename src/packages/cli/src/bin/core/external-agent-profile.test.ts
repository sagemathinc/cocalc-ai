import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXTERNAL_AGENT_TOKEN_PREFIX } from "@cocalc/conat/agents/external";
import {
  externalAgentProfilePath,
  readExternalAgentCredential,
  saveExternalAgentCredential,
  validateExternalAgentCredential,
  type ExternalAgentCredential,
} from "./external-agent-profile";

function credential(): ExternalAgentCredential {
  const account_id = randomUUID(),
    installation_id = randomUUID();
  return {
    version: 1,
    kind: "external-agent",
    api_url: "https://home.test",
    source: {
      kind: "external",
      account_id,
      installation_id,
      agent_id: randomUUID(),
    },
    token: `${EXTERNAL_AGENT_TOKEN_PREFIX}${account_id}.${installation_id}.${randomBytes(32).toString("hex")}`,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
}
test("external credentials use private separate storage and replace atomically", () => {
  const home = mkdtempSync(join(tmpdir(), "external-agent-profile-"));
  try {
    const value = credential();
    const path = saveExternalAgentCredential("soc2", value, home);
    assert.equal(path, externalAgentProfilePath("soc2", home));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readExternalAgentCredential("soc2", home), value);
    const next = credential();
    saveExternalAgentCredential("soc2", next, home);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), next);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("external credential validation rejects native identities, expiry and unsafe origins", () => {
  const good = credential();
  for (const value of [
    { ...good, kind: "human" },
    { ...good, source: { ...good.source, project_id: randomUUID() } },
    { ...good, token: "native-credential" },
    { ...good, expires_at: "2000-01-01" },
    { ...good, api_url: "http://public.test" },
    { ...good, api_url: "https://user:pass@home.test" },
    { ...good, source: { ...good.source, account_id: randomUUID() } },
  ])
    assert.throws(() =>
      validateExternalAgentCredential(value as ExternalAgentCredential),
    );
  validateExternalAgentCredential({
    ...good,
    api_url: "http://localhost:9100",
  });
  for (const name of ["../default", "/tmp/token", "", "a/b"])
    assert.throws(() => externalAgentProfilePath(name));
});
