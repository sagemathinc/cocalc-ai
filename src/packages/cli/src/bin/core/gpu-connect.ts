/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key, step 4: connecting a project to a GPU pod.

`cocalc gpu launch --ssh` makes the pod's key pair here (under a pending
name), sends only its public key, and names the key after the pod's handle.
`cocalc gpu connect <pod>` waits until the pod has registered its host key,
writes the SSH alias with that key pinned (gpu-ssh.ts), and registers a
remote Jupyter kernel on it with reflect. `terminate` undoes both.

Never trust on first use: the host key comes from CoCalc (gpu.sshInfo),
which got it from the pod's one-time registration.
*/

import { execFile } from "node:child_process";
import type { GpuApi } from "@cocalc/conat/hub/api/gpu";
import type { GpuPodSshInfo } from "@cocalc/util/gpu/types";
import {
  adoptPendingKey,
  createPendingKey,
  hasPodKey,
  listPendingKeys,
  listPodSsh,
  removePendingKey,
  removePodSsh,
  writePodSsh,
  type GpuSshOptions,
  type PodKey,
} from "./gpu-ssh";

export const DEFAULT_POD_PYTHON = "/usr/bin/python3";
const TERMINAL = new Set(["stopped", "terminating", "terminated", "failed"]);

export interface ReflectResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GpuConnectDeps extends GpuSshOptions {
  // for tests
  runReflect?: (args: string[]) => Promise<ReflectResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function runReflect(args: string[]): Promise<ReflectResult> {
  return new Promise((resolve) => {
    execFile(
      "reflect",
      args,
      { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 },
      (err: any, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: `${stdout}`,
          stderr: `${stderr}`,
        }),
    );
  });
}

// ---- launch ----

// A pending key for a pod about to be launched; pass its publicKey as the
// spec's ssh_public_key, then adoptLaunchedKey with the returned handle.
export async function newLaunchKey(deps: GpuConnectDeps = {}): Promise<PodKey> {
  return await createPendingKey(deps);
}

export async function adoptLaunchedKey(
  key: PodKey,
  handle: string,
  deps: GpuConnectDeps = {},
): Promise<void> {
  await adoptPendingKey(key.name, handle, deps);
}

// No answer from the server (a timeout, a dropped connection): the launch
// may still be running there. A server's own error is an answer.
export function isTransportError(err: unknown): boolean {
  const code = (err as any)?.code;
  return (
    [408, 499, 503].includes(code) ||
    (typeof code === "string" && /^E[A-Z]+$/.test(code))
  );
}

// A launch with a pending key threw. Without an answer the key is kept, so
// `connect` can adopt it by fingerprint if the pod was made after all. An
// answer is definite: the key is adopted by the pod recorded with it, if
// there is one still alive (e.g. RunPod made it but recording the bind
// failed), and removed otherwise.
export async function settleLaunchKey(
  api: Pick<GpuApi, "pods">,
  key: PodKey,
  err: unknown,
  deps: GpuConnectDeps = {},
): Promise<"kept" | "adopted" | "discarded"> {
  if (isTransportError(err)) return "kept";
  let records: {
    handle: string;
    state: string;
    ssh_key_fingerprint?: string;
  }[];
  try {
    records =
      (await api.pods({ scope: "managed", include_ended: true })).records ?? [];
  } catch {
    return "kept";
  }
  const pod = records.find(
    (r) => r.ssh_key_fingerprint === key.fingerprint && !TERMINAL.has(r.state),
  );
  if (pod) {
    await adoptLaunchedKey(key, pod.handle, deps);
    return "adopted";
  }
  await discardLaunchKey(key, deps);
  return "discarded";
}

// ---- connect ----

export interface GpuConnectResult {
  handle: string;
  // the ssh alias: `ssh <alias>` reaches the pod
  alias: string;
  host_key_fingerprint: string;
  // the Jupyter kernel name, when a kernel was registered
  kernel?: string;
}

// This project's key for the pod: under the handle, or still pending from a
// launch interrupted before it was renamed (matched by fingerprint).
async function ensureKey(
  info: GpuPodSshInfo,
  deps: GpuConnectDeps,
): Promise<void> {
  if (await hasPodKey(info.handle, deps)) return;
  if (info.ssh_key_fingerprint) {
    for (const key of await listPendingKeys(deps)) {
      if (key.fingerprint === info.ssh_key_fingerprint) {
        await adoptPendingKey(key.name, info.handle, deps);
        return;
      }
    }
  }
  throw new Error(
    `This project has no SSH key for ${info.handle}. Pods can be reached only from the project that launched them with --ssh.`,
  );
}

export async function connectGpuPod(
  api: Pick<GpuApi, "sshInfo">,
  pod: string,
  opts: { waitSeconds?: number; kernel?: boolean; python?: string } = {},
  deps: GpuConnectDeps = {},
): Promise<GpuConnectResult> {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + Math.max(0, opts.waitSeconds ?? 300) * 1000;
  let info: GpuPodSshInfo;
  for (;;) {
    info = await api.sshInfo({ pod_id: pod });
    if (info.ready) break;
    if (TERMINAL.has(info.state)) {
      throw new Error(`Pod ${info.handle} is ${info.state}.`);
    }
    if (now() >= deadline) {
      throw new Error(
        `Pod ${info.handle} hasn't registered its SSH host key yet (it is ${info.state}). Try again shortly.`,
      );
    }
    await sleep(5000);
  }
  if (!info.host || !info.port || !info.user || !info.host_public_key) {
    throw new Error("CoCalc returned incomplete SSH details for this pod.");
  }
  await ensureKey(info, deps);
  await writePodSsh(
    {
      handle: info.handle,
      host: info.host,
      port: info.port,
      user: info.user,
      hostKey: info.host_public_key,
    },
    deps,
  );
  const result: GpuConnectResult = {
    handle: info.handle,
    alias: info.handle,
    host_key_fingerprint: info.host_key_fingerprint ?? "",
  };
  if (opts.kernel !== false) {
    const reflect = deps.runReflect ?? runReflect;
    // Re-registering replaces an older registration of the same pod.
    await reflect(["jupyter", "target", "remove", info.handle, "--json"]);
    const added = await reflect([
      "jupyter",
      "target",
      "add",
      info.handle,
      "--json",
      "--host",
      info.handle,
      "--environment",
      "gpu",
      "--python",
      opts.python ?? DEFAULT_POD_PYTHON,
    ]);
    if (added.code !== 0) {
      const why =
        added.stderr.trim().split("\n").slice(-1)[0] || "reflect failed";
      throw new Error(
        `The SSH alias ${info.handle} works, but the Jupyter kernel couldn't be set up: ${why}`,
      );
    }
    let kernel = `reflect-${info.handle}`;
    try {
      kernel = JSON.parse(added.stdout).kernel ?? kernel;
    } catch {}
    result.kernel = kernel;
  }
  return result;
}

// ---- after terminate ----

// Forget a pod here: its kernel registration, SSH alias, pinned host key and
// key pair. Does nothing (and touches no SSH config) for a pod this project
// has no key or alias for.
export async function disconnectGpuPod(
  handle: string,
  deps: GpuConnectDeps = {},
  // the pod's recorded key: a launch interrupted before the key took the
  // handle left it pending under this fingerprint
  ssh_key_fingerprint?: string,
): Promise<boolean> {
  let pendingRemoved = false;
  if (ssh_key_fingerprint) {
    for (const key of await listPendingKeys(deps)) {
      if (key.fingerprint === ssh_key_fingerprint) {
        await removePendingKey(key.name, deps);
        pendingRemoved = true;
      }
    }
  }
  const hasKey = await hasPodKey(handle, deps);
  const hasAlias = (await listPodSsh(deps)).some((p) => p.handle === handle);
  if (!hasKey && !hasAlias) return pendingRemoved;
  await (deps.runReflect ?? runReflect)([
    "jupyter",
    "target",
    "remove",
    handle,
    "--stop",
    "--json",
  ]);
  await removePodSsh(handle, deps);
  return true;
}

// A launch that failed outright leaves its pending key behind.
export async function discardLaunchKey(
  key: PodKey,
  deps: GpuConnectDeps = {},
): Promise<void> {
  await removePendingKey(key.name, deps);
}
