import { createPublicKey } from "crypto";
import getLogger from "@cocalc/backend/logger";
import { getProjectHostAuthTokenPublicKey as getDefaultPublicKey } from "@cocalc/backend/data";

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
  } catch (err) {
    logger.warn("ignoring invalid distributed project-host auth public key", {
      err,
    });
  }
}

export function getProjectHostAuthPublicKey(): string {
  if (distributedPublicKey) {
    return distributedPublicKey;
  }
  return getDefaultPublicKey();
}

