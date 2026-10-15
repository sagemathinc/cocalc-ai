/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export interface ClosableLease {
  close(): Promise<void>;
}

export interface RenewableCliLease<L extends ClosableLease> {
  /** The live lease, or a fresh one if the previous lease was retired. */
  acquire(): Promise<L>;
  /** Fence CLI authority now: delete the lease and its files. */
  retire(): Promise<void>;
  readonly current: L | undefined;
  close(): Promise<void>;
}

/**
 * Owns the project CLI token and agent identity lease of one Claude controller.
 *
 * A command whose cleanup is unconfirmed may have left a process that can read
 * the lease's files, so the lease is retired at once. The project tool layer
 * then refuses commands until the runtime proves every fenced job's processes
 * are gone. The next command after that gets a fresh lease. Without one, the
 * rest of the session would run with no agent identity or CLI credentials,
 * including new turns of the same controller.
 */
export function createRenewableCliLease<L extends ClosableLease>(
  create: () => Promise<L | undefined>,
): RenewableCliLease<L> {
  let current: L | undefined;
  let pending: Promise<L> | undefined;
  // Bumped by retire and close: a lease created across a fence is discarded,
  // since a process of the fenced job may still be alive to read it.
  let generation = 0;
  let closed = false;
  const acquire = async (): Promise<L> => {
    if (closed) throw Error("Claude controller is closed");
    if (current) return current;
    pending ??= (async () => {
      const started = generation;
      try {
        const lease = await create();
        if (!lease) throw Error("Scoped Claude CLI credentials unavailable");
        if (closed || started !== generation) {
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
  const retire = async () => {
    generation++;
    const lease = current;
    current = undefined;
    await lease?.close();
  };
  return {
    acquire,
    retire,
    get current() {
      return current;
    },
    close: async () => {
      closed = true;
      await retire();
      await pending?.catch(() => undefined);
    },
  };
}
