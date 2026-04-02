import { createPublicKey } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import getLogger from "@cocalc/backend/logger";
import {
  getConfiguredProjectHostAuthTokenPublicKey,
  projectHostAuthTokenPublicKeyPath,
} from "@cocalc/backend/data";

const logger = getLogger("project-host:auth-public-key");

let distributedPublicKey: string | undefined;

function normalizePublicKey(publicKey: string): string {
  const keyObj = createPublicKey(publicKey);
  const pem = keyObj.export({ type: "spki", format: "pem" });
  return `${pem}`.trim();
}

export function setProjectHostAuthPublicKey(publicKey?: string) {
  const value = `${publicKey ?? ""}`.trim();
  if (!value) {
    return;
  }
  try {
    distributedPublicKey = normalizePublicKey(value);
    mkdirSync(dirname(projectHostAuthTokenPublicKeyPath), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      projectHostAuthTokenPublicKeyPath,
      `${distributedPublicKey}\n`,
      { mode: 0o644 },
    );
  } catch (err) {
    logger.warn("ignoring invalid distributed project-host auth public key", {
      err,
      path: projectHostAuthTokenPublicKeyPath,
    });
  }
}

export function getProjectHostAuthPublicKey(): string {
  if (distributedPublicKey) {
    return distributedPublicKey;
  }
  const configured = getConfiguredProjectHostAuthTokenPublicKey();
  if (configured) {
    return normalizePublicKey(configured);
  }
  throw new Error(
    "project-host auth public key is not loaded yet; wait for master registration to supply project_host_auth_public_key or set COCALC_PROJECT_HOST_AUTH_TOKEN_PUBLIC_KEY",
  );
}
