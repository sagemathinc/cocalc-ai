/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Hub API entry points for sensors. Sensors live on the project's bay; these
// authenticate on the caller's bay and route there.

import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import type { SensorControlRequest } from "@cocalc/conat/agents/sensors";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { withAgentIdentityOwner } from "./identity-routing";
import { sensorControlLocal } from "./sensors";

const MANAGE_OPS = new Set([
  "approve",
  "reject",
  "pause",
  "resume",
  "delete",
  "run",
]);

export async function sensorControl(
  account_id: string,
  project_id: string,
  request: SensorControlRequest,
): Promise<any> {
  return await withAgentIdentityOwner({
    project_id,
    local: () => sensorControlLocal(account_id, project_id, request),
    remote: (api, route) =>
      api.sensors({ account_id, project_id, route, request }),
  });
}

export const listSensors: AgentApi["listSensors"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  return await sensorControl(opts.account_id!, opts.project_id, {
    op: "list",
    ...(opts.agent_id ? { agent_id: opts.agent_id } : {}),
    ...(opts.sensor_id ? { sensor_id: opts.sensor_id } : {}),
  });
};

export const manageSensor: AgentApi["manageSensor"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  if (!MANAGE_OPS.has(opts.op)) throw new Error("unsupported sensor operation");
  // Only a person in a signed-in browser session changes what runs; agent
  // credentials never reach here (the API policy refuses them).
  await requireDangerousSessionAuth({
    account_id: opts.account_id!,
    session_hash: opts.session_hash,
    require_second_factor: "if_enabled",
    allow_actor_impersonation: false,
  });
  return await sensorControl(opts.account_id!, opts.project_id, {
    op: opts.op,
    sensor_id: opts.sensor_id,
    ...(opts.revision !== undefined ? { revision: opts.revision } : {}),
  });
};

export const authorizeSensorExecution: AgentApi["authorizeSensorExecution"] =
  async (opts) => {
    const account_id = `${opts.account_id ?? ""}`.trim();
    const host_id = `${opts.host_id ?? ""}`.trim();
    requireUuid(account_id, "account_id");
    requireUuid(host_id, "host_id");
    const project_id = opts.authorization?.project_id;
    requireUuid(project_id, "project_id");
    await sensorControl(account_id, project_id, {
      op: "authorize-execution",
      host_id,
      authorization: opts.authorization,
    });
  };
