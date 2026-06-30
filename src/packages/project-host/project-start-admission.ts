/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import { getMasterConatClient } from "./master-status";
import { getLocalHostId } from "./sqlite/hosts";
import { getProjectStopState } from "./sqlite/stop-policy";

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

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
  const project = `${project_id ?? ""}`.trim();
  if (!project) {
    throw new Error("project id is required to start a project");
  }
  const pressureCooldownUntilMs =
    getProjectStopState(project)?.pressure_cooldown_until_ms;
  const now = Date.now();
  if (
    pressureCooldownUntilMs != null &&
    Number(pressureCooldownUntilMs) > now
  ) {
    throw new Error(
      `Project start is temporarily blocked because this project was recently stopped after exceeding project-host resource limits. Try again in ${formatDuration(
        Number(pressureCooldownUntilMs) - now,
      )}. You can still browse files and delete files without starting the project. If this keeps happening, reduce the workload or contact support.`,
    );
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
        project_id: project,
        ...(autostart ? { autostart } : {}),
        wait,
      },
    ],
    timeout,
  });
}
