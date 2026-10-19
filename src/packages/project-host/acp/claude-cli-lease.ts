/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { SandboxExecResult } from "@cocalc/project-runner/run/sandbox-exec";
import type { ProjectJobExecutor } from "./claude-project-jobs";

export interface ClosableLease {
  close(): Promise<void>;
}

export interface RenewableCliLease<L extends ClosableLease> {
  /** The live lease, or a fresh one; rejects while a fence is up. */
  acquire(): Promise<L>;
  /**
   * Fence CLI authority now: no lease is issued until every fence is lifted,
   * and the current lease is closed (its files deleted). `reopen` lifts this
   * fence; call it only on the runtime's proof that the fenced command's
   * processes are gone.
   */
  retire(): { reopen: () => void; closed: Promise<void> };
  readonly current: L | undefined;
  close(): Promise<void>;
}

/**
 * Owns the project CLI token and agent identity lease of one Claude controller.
 *
 * A command whose cleanup is unconfirmed may have left a process that can read
 * the lease's files, so the lease is retired at once and no new one is issued
 * until the runtime proves that command's processes are gone. The next command
 * after that gets a fresh lease. Without one, the rest of the session would run
 * with no agent identity or CLI credentials, including new turns of the same
 * controller.
 */
export function createRenewableCliLease<L extends ClosableLease>(
  create: () => Promise<L | undefined>,
): RenewableCliLease<L> {
  let current: L | undefined;
  let pending: Promise<L> | undefined;
  // Bumped by retire and close: a lease created across a fence is discarded,
  // since a process of the fenced command may still be alive to read it.
  let generation = 0;
  const fences = new Set<object>();
  let closed = false;
  const acquire = async (): Promise<L> => {
    if (closed) throw Error("Claude controller is closed");
    if (fences.size > 0)
      throw Error(
        "Claude CLI credentials are paused until the runtime confirms an earlier command's cleanup",
      );
    if (current) return current;
    pending ??= (async () => {
      const started = generation;
      try {
        const lease = await create();
        if (!lease) throw Error("Scoped Claude CLI credentials unavailable");
        if (closed || started !== generation || fences.size > 0) {
          await lease.close();
          throw Error("Claude CLI credentials were revoked; try again");
        }
        current = lease;
        return lease;
      } finally {
        pending = undefined;
      }
    })();
    return await pending;
  };
  const retire = () => {
    generation++;
    const fence = {};
    fences.add(fence);
    const lease = current;
    current = undefined;
    return {
      reopen: () => {
        fences.delete(fence);
      },
      closed: lease ? lease.close() : Promise.resolve(),
    };
  };
  return {
    acquire,
    retire,
    get current() {
      return current;
    },
    close: async () => {
      closed = true;
      const { closed: retired } = retire();
      await retired;
      await pending?.catch(() => undefined);
    },
  };
}

/**
 * The project-tool executor around one controller's CLI lease.
 *
 * - No lease (fenced, or issuing failed): nothing runs, reported with cleanup
 *   confirmed, like a refused admission, so the tool layer stays open and the
 *   agent can retry instead of being blocked until a project restart.
 * - Unconfirmed cleanup or a failed run: the lease is retired with the fence
 *   up until that command's own cleanup proof, which may arrive later from
 *   the runtime's recovery.
 */
export function leasedProjectExecutor<L extends ClosableLease>({
  leases,
  envFor,
  admissionEnv,
  execute,
}: {
  leases: RenewableCliLease<L>;
  envFor: (lease: L) => Record<string, string>;
  /**
   * Taken when the command is admitted, before waiting for a lease: values
   * that belong to the moment it was asked for (the running turn's), which
   * may change before the lease arrives.
   */
  admissionEnv?: () => Record<string, string>;
  execute: (
    env: Record<string, string>,
    ...args: Parameters<ProjectJobExecutor>
  ) => Promise<SandboxExecResult>;
}): ProjectJobExecutor {
  return async (script, cwd, signal, options) => {
    const admitted = admissionEnv?.() ?? {};
    let lease: L;
    try {
      lease = await leases.acquire();
    } catch (error) {
      options.onCleanupConfirmed();
      return {
        stdout: "",
        stderr: `Project command was not started: ${error instanceof Error ? error.message : "CLI credentials unavailable"}. Nothing ran; try again in a minute.`,
        code: null,
        cleanupConfirmed: true,
      };
    }
    // The proof can arrive before the fence is up (a fast recovery) or long
    // after this returns; either way it lifts exactly this command's fence.
    let proven = false;
    let reopen: (() => void) | undefined;
    const fence = () => {
      const retired = leases.retire();
      reopen = retired.reopen;
      if (proven) reopen();
      return retired.closed;
    };
    const confirmed = () => {
      proven = true;
      reopen?.();
      options.onCleanupConfirmed();
    };
    let result: SandboxExecResult;
    try {
      result = await execute(
        { ...envFor(lease), ...admitted },
        script,
        cwd,
        signal,
        {
          ...options,
          onCleanupConfirmed: confirmed,
        },
      );
    } catch (error) {
      await fence();
      throw error;
    }
    // Fence CLI authority independently of process/container cleanup.
    if (result.cleanupConfirmed !== true) await fence();
    return result;
  };
}
