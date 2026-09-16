/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import type { ChildProcess } from "node:child_process";
import type { SpawnedKernel } from "./launch-kernel";

const shutdowns = new Map<string, Promise<unknown>>();

export function trackKernelShutdown(path: string, pending: Promise<unknown>) {
  shutdowns.set(path, pending);
  void pending
    .finally(() => {
      if (shutdowns.get(path) === pending) shutdowns.delete(path);
    })
    .catch(() => {});
}

export async function waitForKernelShutdown(path: string): Promise<void> {
  await shutdowns.get(path);
}

export function isReflectLauncher(kernel: SpawnedKernel | undefined): boolean {
  return kernel?.kernel_spec?.metadata?.reflect?.remote === true;
}

// A proxy launcher needs time to stop its remote kernel. Keep its pipes open
// until exit; destroying stderr early can abort cleanup with an EPIPE error.
export async function stopReflectLauncher(
  child: ChildProcess,
  timeoutMs = 45000,
  leaseGraceMs = 62000,
): Promise<void> {
  let confirmed = child.exitCode === 0;
  if (child.exitCode == null && child.signalCode == null) {
    confirmed = await new Promise<boolean>((resolve) => {
      const done = (code?: number | null) => {
        clearTimeout(timeout);
        child.removeListener("exit", done);
        child.removeListener("error", done);
        resolve(code === 0);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, timeoutMs);
      child.once("exit", done);
      child.once("error", done);
      child.kill("SIGTERM");
    });
  }
  // A killed or crashed launcher cannot confirm remote cleanup. Wait out the
  // registered launcher's 60-second lease before admitting its replacement.
  if (!confirmed)
    await new Promise((resolve) => setTimeout(resolve, leaseGraceMs));
}
