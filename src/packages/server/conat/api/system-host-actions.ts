/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Host actions that trusted server code runs as itself, with no user session
// (e.g. quarantine stopping the hosts an account pays for). Each runs on the
// host's owning bay: here, or forwarded there over the same path as routed
// hub API calls (edge-routing), marked `system`.
//
// Only another bay can send a system call (users' calls are built from their
// authenticated connection and never carry the mark), and bays already trust
// each other. The allow-list keeps this surface small and easy to review; it
// is not meant as a defense against a compromised bay.

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveHostBay } from "@cocalc/server/inter-bay/directory";
import { forwardHubApiCall } from "./edge-routing";

type HostActionOpts = { account_id: string; id: string };

const SYSTEM_HOST_ACTIONS: Record<
  string,
  (opts: HostActionOpts & Record<string, unknown>) => Promise<unknown>
> = {
  "hosts.stopHost": async (opts) =>
    await (
      await import("./hosts")
    ).queueHostStop({
      account_id: opts.account_id,
      id: opts.id,
      skip_backups: opts.skip_backups === true,
    }),
};

export function isSystemHostAction(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SYSTEM_HOST_ACTIONS, name);
}

/** On the host's owning bay: run an allow-listed system action. */
export async function runSystemHostActionHere(
  name: string,
  opts: HostActionOpts & Record<string, unknown>,
): Promise<unknown> {
  if (!isSystemHostAction(name)) {
    throw Object.assign(new Error(`'${name}' is not a system host action`), {
      code: 403,
    });
  }
  return await SYSTEM_HOST_ACTIONS[name](opts);
}

/** Run a system host action on the host's owning bay, wherever that is. */
export async function runHostActionAsSystem(
  name: string,
  opts: HostActionOpts & Record<string, unknown>,
): Promise<unknown> {
  if (!isSystemHostAction(name)) {
    throw new Error(`'${name}' is not a system host action`);
  }
  const owner = (await resolveHostBay(opts.id))?.bay_id;
  if (owner == null || owner === getConfiguredBayId()) {
    return await runSystemHostActionHere(name, opts);
  }
  return await forwardHubApiCall(owner, {
    name,
    args: [opts],
    account_id: opts.account_id,
    system: true,
  });
}
