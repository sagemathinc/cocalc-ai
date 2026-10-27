/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { withSessionAdvisoryLock } from "@cocalc/database/pool";

export const HOST_MACHINE_CHANGE_IN_PROGRESS =
  "host_machine_change_in_progress";

/**
 * A per-host lock held while a host's machine is changed (the row is read,
 * the provider changes the VM, the row is written back), and by every path
 * that must not interleave with that: queueing a start, stop, restart,
 * relocation, deprovision or delete, and billing enforcement's deprovision
 * transition. It doesn't wait: a second holder is refused with
 * HOST_MACHINE_CHANGE_IN_PROGRESS.
 */
export async function withHostMachineChangeLock<T>(
  host_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const result = await withSessionAdvisoryLock({
    lockKey: `project_hosts:machine-change:${host_id}`,
    fn: async () => ({ value: await fn() }),
  });
  if (result == null) {
    throw Object.assign(
      new Error(
        "another change to this host's machine or lifecycle is in progress; try again when it has finished",
      ),
      { code: HOST_MACHINE_CHANGE_IN_PROGRESS },
    );
  }
  return result.value;
}
