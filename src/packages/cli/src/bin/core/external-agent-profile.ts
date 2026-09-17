import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseExternalAgentToken,
  type ExternalAgentSource,
} from "@cocalc/conat/agents/external";
import { requireUuid } from "@cocalc/conat/agents/protocol";

export interface ExternalAgentCredential {
  version: 1;
  kind: "external-agent";
  api_url: string;
  source: ExternalAgentSource;
  token: string;
  expires_at: string;
}

export function externalAgentProfilePath(profile: string, home = homedir()) {
  if (
    typeof profile !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)
  )
    throw new Error("invalid external agent profile name");
  return join(home, ".config", "cocalc", "agents", `${profile}.json`);
}

export function validateExternalAgentCredential(
  value: ExternalAgentCredential,
) {
  if (
    value?.version !== 1 ||
    value.kind !== "external-agent" ||
    value.source?.kind !== "external"
  )
    throw new Error("external agent credential required");
  const parsed = parseExternalAgentToken(value.token);
  requireUuid(value.source.agent_id, "external agent_id");
  if (
    parsed.account_id !== value.source.account_id ||
    parsed.installation_id !== value.source.installation_id ||
    "project_id" in value.source ||
    "run_id" in value.source
  )
    throw new Error("external agent credential identity mismatch");
  const url = new URL(value.api_url);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("external agent API requires HTTPS (or loopback HTTP)");
  if (
    !Number.isFinite(Date.parse(value.expires_at)) ||
    Date.parse(value.expires_at) <= Date.now()
  )
    throw new Error("external agent credential expired");
}

/** Separate storage from human auth profiles. Never makes this ambient account
 * authority, and never prints the credential in the command result. */
export function saveExternalAgentCredential(
  profile: string,
  value: ExternalAgentCredential,
  home = homedir(),
) {
  validateExternalAgentCredential(value);
  const path = externalAgentProfilePath(profile, home);
  const directory = join(home, ".config", "cocalc", "agents");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw Object.assign(
          new Error("failed to save and clean up external agent credential"),
          { cause: error, cleanupError },
        );
      }
    }
    throw error;
  }
  return path;
}

export function readExternalAgentCredential(
  profile: string,
  home = homedir(),
): ExternalAgentCredential {
  const value = JSON.parse(
    readFileSync(externalAgentProfilePath(profile, home), "utf8"),
  );
  validateExternalAgentCredential(value);
  return value;
}
