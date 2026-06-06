/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import { getMasterConatClient } from "./master-status";
import { getLocalHostId } from "./sqlite/hosts";

export async function startProjectWithAdmission({
  account_id,
  project_id,
  autostart,
  wait = true,
  timeout = 90_000,
}: {
  account_id?: string;
  project_id: string;
  autostart?: boolean;
  wait?: boolean;
  timeout?: number;
}) {
  const actor = `${account_id ?? ""}`.trim();
  if (!actor) {
    throw new Error("account id is required to start a project");
  }
  const client = getMasterConatClient();
  if (!client) {
    throw new Error("master hub connection unavailable for project start");
  }
  const host_id = getLocalHostId();
  if (!host_id) {
    throw new Error("host id is required to start a project");
  }
  return await callHub({
    client,
    host_id,
    name: "projects.startFromHost",
    args: [
      {
        account_id: actor,
        project_id,
        ...(autostart ? { autostart } : {}),
        wait,
      },
    ],
    timeout,
  });
}
