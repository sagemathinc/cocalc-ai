import { createPublicKey } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import getLogger from "@cocalc/backend/logger";
import {
  getConfiguredProjectHostAuthTokenPublicKey,
  projectHostAuthTokenPublicKeyPath,
} from "@cocalc/backend/data";

const logger = getLogger("project-host:auth-public-key");

let distributedPublicKey: string | undefined;
// The key last written (or being written) to projectHostAuthTokenPublicKeyPath.
let persistedPublicKey: string | undefined;
let persistChain: Promise<void> = Promise.resolve();

function normalizePublicKey(publicKey: string): string {
  const keyObj = createPublicKey(publicKey);
  const pem = keyObj.export({ type: "spki", format: "pem" });
  return `${pem}`.trim();
}

// The hub publishes every host's keys to every host, so this runs often with
// the same key. Write the file only when the key changes, and asynchronously:
// a synchronous open-with-truncate on the host's btrfs filesystem waits for
// the running transaction commit, which stalled the whole event loop.
export function setProjectHostAuthPublicKey(publicKey?: string) {
  const value = `${publicKey ?? ""}`.trim();
  if (!value) {
    return;
  }
  let normalized: string;
  try {
    normalized = normalizePublicKey(value);
  } catch (err) {
    logger.warn("ignoring invalid distributed project-host auth public key", {
      err,
      path: projectHostAuthTokenPublicKeyPath,
    });
    return;
  }
  distributedPublicKey = normalized;
  if (normalized === persistedPublicKey) {
    return;
  }
  persistedPublicKey = normalized;
  persistChain = persistChain.then(async () => {
    try {
      await mkdir(dirname(projectHostAuthTokenPublicKeyPath), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(projectHostAuthTokenPublicKeyPath, `${normalized}\n`, {
        mode: 0o644,
      });
    } catch (err) {
      // Try again the next time the key arrives.
      if (persistedPublicKey === normalized) {
        persistedPublicKey = undefined;
      }
      logger.warn("unable to save the project-host auth public key", {
        err,
        path: projectHostAuthTokenPublicKeyPath,
      });
    }
  });
}

/** Resolves once every requested write of the public key has finished. */
export async function flushProjectHostAuthPublicKey(): Promise<void> {
  await persistChain;
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
