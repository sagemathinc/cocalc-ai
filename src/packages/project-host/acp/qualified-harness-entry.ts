/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getQualifiedHarnessCandidate } from "@cocalc/util/ai/qualified-harnesses";
import { PROJECT_SECRETS_MOUNT_PATH } from "@cocalc/util/project-secrets-constants";

const MAX_SECRET_BYTES = 16 * 1024;

export async function qualifiedHarnessLaunch(
  id: string,
  revision: string,
): Promise<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> {
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
  if (credential) {
    const value = await readFile(
      join(PROJECT_SECRETS_MOUNT_PATH, credential.name),
      { encoding: "utf8", flag: "r" },
    );
    if (!value.trim() || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
      throw Error(`Project secret ${credential.name} is invalid`);
    }
    env[credential.environmentVariable] = value.trim();
  }
  return {
    executable: candidate.launch.executable,
    args: [...candidate.launch.requiredArgs],
    env,
  };
}

async function main(): Promise<void> {
  const [, , id, revision, ...unexpected] = process.argv;
  if (!id || !revision || unexpected.length) {
    throw Error("Invalid qualified ACP launch request");
  }
  const launch = await qualifiedHarnessLaunch(id, revision);
  const child = spawn(launch.executable, launch.args, {
    env: launch.env,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) return resolve(128);
      resolve(code ?? 1);
    });
  });
  process.exitCode = code;
}

if (require.main === module) {
  void main().catch((error) => {
    // Never include secret contents or child output in launch errors.
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
