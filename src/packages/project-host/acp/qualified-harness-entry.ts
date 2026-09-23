/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getQualifiedHarnessCandidate } from "@cocalc/util/ai/qualified-harnesses";
import { PROJECT_SECRETS_MOUNT_PATH } from "@cocalc/util/project-secrets-constants";
import { createCredentialRelayBridge } from "./credential-relay-bridge";
import type { CredentialRelayBridge } from "./credential-relay-bridge";

const MAX_SECRET_BYTES = 16 * 1024;
const CREDENTIAL_RELAY_MOUNT = "/run/cocalc/credential-relay";

export async function qualifiedHarnessLaunch(
  id: string,
  revision: string,
  credentialMode: "project-secret" | "account-api-key" = "project-secret",
): Promise<{
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  close(): Promise<void>;
}> {
  const candidate = getQualifiedHarnessCandidate(id);
  if (
    !candidate ||
    candidate.status === "disabled" ||
    candidate.package.version !== revision
  ) {
    throw Error("Qualified ACP harness is not available");
  }
  const env = { ...process.env };
  const credential = candidate.launch.projectSecret;
  let bridge: CredentialRelayBridge | undefined;
  if (credential && credentialMode === "project-secret") {
    const value = await readFile(
      join(PROJECT_SECRETS_MOUNT_PATH, credential.name),
      { encoding: "utf8", flag: "r" },
    );
    if (!value.trim() || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
      throw Error(`Project secret ${credential.name} is invalid`);
    }
    env[credential.environmentVariable] = value.trim();
  } else if (credential && credentialMode === "account-api-key") {
    const token = (
      await readFile(join(CREDENTIAL_RELAY_MOUNT, "token"), {
        encoding: "utf8",
        flag: "r",
      })
    ).trim();
    bridge = await createCredentialRelayBridge({
      socketPath: join(CREDENTIAL_RELAY_MOUNT, "relay.sock"),
      token,
    });
    env.ANTHROPIC_BASE_URL = bridge.baseUrl;
    env[credential.environmentVariable] = "cocalc-credential-relay";
  }
  return {
    executable: candidate.launch.executable,
    args: [...candidate.launch.requiredArgs],
    env,
    close: async () => {
      await bridge?.close();
    },
  };
}

async function main(): Promise<void> {
  const [, , id, revision, credentialMode, ...unexpected] = process.argv;
  if (
    !id ||
    !revision ||
    (credentialMode !== "project-secret" &&
      credentialMode !== "account-api-key") ||
    unexpected.length
  ) {
    throw Error("Invalid qualified ACP launch request");
  }
  const launch = await qualifiedHarnessLaunch(id, revision, credentialMode);
  const child = spawn(launch.executable, launch.args, {
    env: launch.env,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) return resolve(128);
        resolve(code ?? 1);
      });
    });
    process.exitCode = code;
  } finally {
    await launch.close();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    // Never include secret contents or child output in launch errors.
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
