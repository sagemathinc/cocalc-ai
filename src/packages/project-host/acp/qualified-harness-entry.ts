/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
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
  providerBaseUrl?: string;
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
    providerBaseUrl: bridge?.baseUrl,
    close: async () => {
      await bridge?.close();
    },
  };
}

/** Pin the adapter's programmatic settings tier before accepting any session. */
export async function pinClaudeProvider(
  child: ChildProcessWithoutNullStreams,
  baseUrl: string,
  output: NodeJS.WritableStream,
): Promise<void> {
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  const fail = () => {
    for (const request of pending.values())
      request.reject(Error("Claude provider setup failed"));
    pending.clear();
  };
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail();
      return;
    }
    const request = pending.get(message.id);
    if (!request) {
      output.write(line + "\n");
      return;
    }
    pending.delete(message.id);
    if (message.error) request.reject(Error("Claude provider setup rejected"));
    else request.resolve(message.result);
  });
  lines.on("close", fail);
  child.on("error", fail);
  const request = (id: string, method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("Claude provider setup timed out"));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  // Gateway auth also suppresses ambient CLI login probes. A provider override
  // alone still probes project-controlled login/settings before session setup.
  await request("cocalc-provider-auth", "authenticate", {
    methodId: "gateway",
    _meta: { gateway: { baseUrl, headers: {} } },
  });
  await request("cocalc-provider-set", "providers/set", {
    providerId: "main",
    apiType: "anthropic",
    baseUrl,
    headers: {},
  });
  const result = await request("cocalc-provider-check", "providers/list", {});
  if (
    result?.providers?.length !== 1 ||
    result.providers[0].providerId !== "main" ||
    result.providers[0].current?.apiType !== "anthropic" ||
    result.providers[0].current?.baseUrl !== baseUrl
  )
    throw Error("Claude provider route could not be verified");
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
    stdio: "pipe",
  });
  child.stderr.pipe(process.stderr);
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
  void exited.catch(() => {});
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  try {
    if (launch.providerBaseUrl)
      await pinClaudeProvider(child, launch.providerBaseUrl, process.stdout);
    else child.stdout.pipe(process.stdout);
    process.stdin.pipe(child.stdin);
    process.exitCode = await exited;
  } finally {
    child.kill("SIGKILL");
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
