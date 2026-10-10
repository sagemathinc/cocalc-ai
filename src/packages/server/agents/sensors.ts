/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Sensors: scripts an agent proposes and a person approves, which CoCalc runs
// on a schedule and which may wake the agent. These records live on the
// project's bay, next to the agent identity they belong to. Every function
// here runs on that bay; callers route there first (see sensor-routing.ts).

import { createHash } from "node:crypto";
import { requireUuid, type AgentIdentity } from "@cocalc/conat/agents/protocol";
import {
  SENSOR_DEFAULT_MAX_WAKES_PER_DAY,
  SENSOR_DEFAULT_MIN_INTERVAL_MINUTES,
  SENSOR_LIMITS,
  sensorSpecCanonicalJson,
  validateSensorSpec,
  type AgentSensor,
  type AgentSensorRequest,
  type AgentSensorRun,
  type SensorControlRequest,
  type SensorExecutionAuthorization,
  type SensorSpec,
} from "@cocalc/conat/agents/sensors";
import { nextSensorRunAt } from "@cocalc/util/ai/sensor-schedule";
import { getAccountProductAccessTrust } from "@cocalc/server/accounts/trusted-product-access";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { assertProjectHostAgentTokenAccess } from "@cocalc/server/conat/api/project-host-token-auth";
import { assertActor, assertAgent } from "./access";
import { agentStore, type AgentRun } from "./store";

/** Active sensors per project when a tier does not set a limit. */
const DEFAULT_MAX_ACTIVE = 20;
/** People may start a sensor by hand at most this often. */
const MANUAL_RUN_MIN_GAP_MS = 60_000;

export interface SensorLimits {
  maxActive: number;
  minIntervalMinutes: number;
  maxWakesPerDay: number;
}

export async function sensorLimits(account_id: string): Promise<SensorLimits> {
  const trust = await getAccountProductAccessTrust(account_id);
  if (!trust.trusted)
    return {
      maxActive: 0,
      minIntervalMinutes: SENSOR_DEFAULT_MIN_INTERVAL_MINUTES,
      maxWakesPerDay: 0,
    };
  const limits =
    (await resolveMembershipForAccount(account_id)).effective_limits ?? {};
  const count = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  return {
    maxActive: count(
      limits.acp_max_active_automations_per_project,
      DEFAULT_MAX_ACTIVE,
    ),
    minIntervalMinutes: Math.max(
      1,
      count(
        limits.sensor_min_interval_minutes,
        SENSOR_DEFAULT_MIN_INTERVAL_MINUTES,
      ),
    ),
    maxWakesPerDay: count(
      limits.sensor_max_wakes_per_day,
      SENSOR_DEFAULT_MAX_WAKES_PER_DAY,
    ),
  };
}

const NO_SENSORS =
  "Your membership does not include agent sensors. Upgrade your membership to use them.";
const NO_INTERNET =
  "Sensors need a project with internet access. Upgrade the project's membership to enable internet access, then try again.";

/** Projects reach the internet only when their run quota says so. */
export async function projectHasInternet(project_id: string): Promise<boolean> {
  const { rows } = await agentStore().query<{ network: unknown }>(
    "SELECT run_quota->'network' AS network FROM projects WHERE project_id=$1 AND deleted IS NOT TRUE",
    [project_id],
  );
  const network = rows[0]?.network;
  return network === true || network === 1;
}

export function sensorSpecHash(spec: SensorSpec): string {
  return createHash("sha256")
    .update(sensorSpecCanonicalJson(spec))
    .digest("hex");
}

const iso = (value: unknown): string | null =>
  value == null ? null : new Date(value as any).toISOString();

export function toSensor(row: any): AgentSensor {
  return {
    sensor_id: row.sensor_id,
    project_id: row.project_id,
    agent_id: row.agent_id,
    status: row.status,
    spec: row.spec ?? null,
    script_hash: row.script_hash ?? null,
    pending_spec: row.pending_spec ?? null,
    pending_hash: row.pending_hash ?? null,
    proposed_at: iso(row.proposed_at),
    revision: row.revision,
    approved_by: row.approved_by ?? null,
    approved_at: iso(row.approved_at),
    pause_reason: row.pause_reason ?? null,
    next_run_at: row.status === "active" ? iso(row.next_run_at) : null,
    last_run_at: iso(row.last_run_at),
    last_outcome: row.last_outcome ?? null,
    last_wake_at: iso(row.last_wake_at),
    consecutive_failures: row.consecutive_failures ?? 0,
    wakes_today:
      row.wakes_day === utcDay(new Date()) ? (row.wakes_today ?? 0) : 0,
    created: iso(row.created)!,
    updated: iso(row.updated)!,
  };
}

export function toSensorRun(row: any): AgentSensorRun {
  return {
    run_id: row.run_id,
    sensor_id: row.sensor_id,
    started_at: iso(row.started_at)!,
    finished_at: iso(row.finished_at),
    outcome: row.outcome ?? null,
    exit_code: row.exit_code ?? null,
    summary: row.summary ?? null,
    output: row.output ?? null,
    error: row.error ?? null,
    manual: !!row.manual,
  };
}

export const utcDay = (date: Date) => date.toISOString().slice(0, 10);

async function recentRuns(
  sensor_id: string,
  limit: number,
): Promise<AgentSensorRun[]> {
  const { rows } = await agentStore().query(
    "SELECT * FROM agent_sensor_runs WHERE sensor_id=$1 ORDER BY started_at DESC LIMIT $2",
    [sensor_id, limit],
  );
  return rows.map(toSensorRun);
}

async function activeCount(project_id: string): Promise<number> {
  const { rows } = await agentStore().query<{ n: string }>(
    "SELECT count(*) AS n FROM agent_sensors WHERE project_id=$1 AND status='active'",
    [project_id],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Operations an agent performs with its identity credential. The run is
 * already authenticated and authorized by the agent messaging service. Agents
 * propose, inspect, pause and delete; only people approve, resume or run.
 */
export async function agentSensorRequest(
  run: AgentRun,
  agent: AgentIdentity,
  request: AgentSensorRequest,
): Promise<unknown> {
  const db = agentStore();
  if (request.op === "list") {
    const { rows } = await db.query(
      "SELECT * FROM agent_sensors WHERE agent_id=$1 ORDER BY created",
      [agent.agent_id],
    );
    return { sensors: rows.map(toSensor) };
  }
  if (request.op === "show") {
    const { rows } = await db.query(
      "SELECT * FROM agent_sensors WHERE sensor_id=$1 AND agent_id=$2",
      [request.sensor_id, agent.agent_id],
    );
    if (!rows[0]) throw new Error("sensor not found");
    return {
      sensor: toSensor(rows[0]),
      runs: await recentRuns(request.sensor_id, 10),
    };
  }
  if (request.op === "pause") {
    const { rows } = await db.query(
      `UPDATE agent_sensors SET status='paused', pause_reason='Paused by the agent',
         revision=revision+1, updated=now()
       WHERE sensor_id=$1 AND agent_id=$2 AND status='active' RETURNING *`,
      [request.sensor_id, agent.agent_id],
    );
    if (!rows[0]) throw new Error("no active sensor with that id");
    return { sensor: toSensor(rows[0]) };
  }
  if (request.op === "delete") {
    const { rowCount } = await db.query(
      "DELETE FROM agent_sensors WHERE sensor_id=$1 AND agent_id=$2",
      [request.sensor_id, agent.agent_id],
    );
    if (!rowCount) throw new Error("sensor not found");
    return { deleted: request.sensor_id };
  }
  // propose
  const limits = await sensorLimits(run.account_id);
  if (limits.maxActive === 0) throw new Error(NO_SENSORS);
  const spec = validateSensorSpec(request.spec, {
    minIntervalMinutes: limits.minIntervalMinutes,
    maxWakesPerDay: Math.max(1, limits.maxWakesPerDay),
  });
  if (!(await projectHasInternet(agent.project_id)))
    throw new Error(NO_INTERNET);
  const hash = sensorSpecHash(spec);
  let row: any;
  if (request.sensor_id) {
    const { rows } = await db.query(
      `UPDATE agent_sensors SET pending_spec=$3, pending_hash=$4,
         proposed_at=now(), proposed_run_id=$5, revision=revision+1,
         status=CASE WHEN status='rejected' THEN 'pending' ELSE status END,
         updated=now()
       WHERE sensor_id=$1 AND agent_id=$2
         AND script_hash IS DISTINCT FROM $4
       RETURNING *`,
      [request.sensor_id, agent.agent_id, spec, hash, run.run_id],
    );
    if (!rows[0])
      throw new Error(
        "sensor not found, or this spec is identical to the approved one",
      );
    row = rows[0];
  } else {
    const { rows } = await db.query(
      `INSERT INTO agent_sensors (sensor_id, project_id, agent_id, status,
         pending_spec, pending_hash, proposed_at, proposed_run_id, revision,
         consecutive_failures, wakes_today)
       SELECT gen_random_uuid(), $1, $2, 'pending', $3, $4, now(), $5, 1, 0, 0
       WHERE (SELECT count(*) FROM agent_sensors WHERE agent_id=$2) < $6
       RETURNING *`,
      [
        agent.project_id,
        agent.agent_id,
        spec,
        hash,
        run.run_id,
        SENSOR_LIMITS.maxSensorsPerAgent,
      ],
    );
    if (!rows[0])
      throw new Error(
        `an agent may have at most ${SENSOR_LIMITS.maxSensorsPerAgent} sensors; delete one first`,
      );
    row = rows[0];
  }
  return {
    sensor: toSensor(row),
    message:
      "Proposed. Nothing runs until a person approves this exact spec in the agent's Sensors panel. Tell the user what it does and ask them to review it.",
  };
}

async function loadForProject(
  sensor_id: string,
  project_id: string,
): Promise<any> {
  requireUuid(sensor_id, "sensor_id");
  const { rows } = await agentStore().query(
    "SELECT * FROM agent_sensors WHERE sensor_id=$1 AND project_id=$2",
    [sensor_id, project_id],
  );
  if (!rows[0]) throw new Error("sensor not found");
  return rows[0];
}

async function assertSensorAgent(agent_id: string): Promise<void> {
  const agent = await agentStore().get(agent_id);
  await assertAgent(agent);
}

/** Checks that must hold whenever a person makes a sensor active. */
async function assertCanActivate(
  account_id: string,
  row: any,
  spec: SensorSpec,
): Promise<void> {
  const limits = await sensorLimits(account_id);
  if (limits.maxActive === 0) throw new Error(NO_SENSORS);
  // The approver's own membership limits apply: their account pays for wakes.
  validateSensorSpec(spec, {
    minIntervalMinutes: limits.minIntervalMinutes,
    maxWakesPerDay: Math.max(1, limits.maxWakesPerDay),
  });
  if (!(await projectHasInternet(row.project_id))) throw new Error(NO_INTERNET);
  if (
    row.status !== "active" &&
    (await activeCount(row.project_id)) >= limits.maxActive
  )
    throw new Error(
      `This project already has ${limits.maxActive} active sensors, the most your membership allows. Pause or delete one first.`,
    );
  await assertSensorAgent(row.agent_id);
}

/**
 * People's sensor operations. The caller has authenticated `account_id` and,
 * for every change, a bound human session; this checks project access.
 */
export async function sensorControlLocal(
  account_id: string,
  project_id: string,
  request: SensorControlRequest,
): Promise<unknown> {
  requireUuid(account_id, "account_id");
  requireUuid(project_id, "project_id");
  if (request.op === "authorize-execution")
    return await authorizeSensorExecutionLocal(
      account_id,
      project_id,
      request.host_id,
      request.authorization,
    );
  await assertActor(account_id, project_id);
  const db = agentStore();
  if (request.op === "list") {
    if (request.sensor_id) {
      const row = await loadForProject(request.sensor_id, project_id);
      return {
        sensors: [toSensor(row)],
        runs: await recentRuns(row.sensor_id, SENSOR_LIMITS.keepRuns),
      };
    }
    if (request.agent_id) requireUuid(request.agent_id, "agent_id");
    const { rows } = await db.query(
      `SELECT * FROM agent_sensors WHERE project_id=$1
         AND ($2::uuid IS NULL OR agent_id=$2) ORDER BY created`,
      [project_id, request.agent_id ?? null],
    );
    return { sensors: rows.map(toSensor) };
  }
  const row = await loadForProject(request.sensor_id, project_id);
  if (request.revision !== undefined && request.revision !== row.revision)
    throw new Error(
      "This sensor changed since you looked at it. Review it again.",
    );
  const update = async (sql: string, values: unknown[]) => {
    const { rows } = await db.query(
      `UPDATE agent_sensors SET ${sql}, revision=revision+1, updated=now()
       WHERE sensor_id=$1 AND revision=$2 RETURNING *`,
      [row.sensor_id, row.revision, ...values],
    );
    if (!rows[0])
      throw new Error(
        "This sensor changed since you looked at it. Review it again.",
      );
    return { sensor: toSensor(rows[0]) };
  };
  switch (request.op) {
    case "approve": {
      if (!row.pending_spec) throw new Error("nothing is waiting for approval");
      if (request.revision === undefined)
        throw new Error("approval must name the revision you reviewed");
      const spec = row.pending_spec as SensorSpec;
      if (sensorSpecHash(spec) !== row.pending_hash)
        throw new Error("pending spec does not match its hash");
      await assertCanActivate(account_id, row, spec);
      const next = nextSensorRunAt(spec.schedule, Date.now());
      return await update(
        `spec=pending_spec, script_hash=pending_hash, pending_spec=NULL,
         pending_hash=NULL, proposed_at=NULL, proposed_run_id=NULL,
         status='active', approved_by=$3, approved_at=now(), pause_reason=NULL,
         consecutive_failures=0, next_run_at=$4`,
        [account_id, next ? new Date(next) : null],
      );
    }
    case "reject":
      if (!row.pending_spec) throw new Error("nothing is waiting for approval");
      return await update(
        `pending_spec=NULL, pending_hash=NULL, proposed_at=NULL,
         proposed_run_id=NULL,
         status=CASE WHEN spec IS NULL THEN 'rejected' ELSE status END`,
        [],
      );
    case "pause":
      if (row.status !== "active") throw new Error("sensor is not active");
      return await update(
        "status='paused', pause_reason='Paused by a person'",
        [],
      );
    case "resume": {
      if (row.status !== "paused" || !row.spec)
        throw new Error("only a paused, approved sensor can be resumed");
      await assertCanActivate(account_id, row, row.spec);
      const next = nextSensorRunAt(row.spec.schedule, Date.now());
      // Whoever resumes takes over the approval: wakes run as them.
      return await update(
        `status='active', pause_reason=NULL, consecutive_failures=0,
         approved_by=$3, approved_at=now(), next_run_at=$4`,
        [account_id, next ? new Date(next) : null],
      );
    }
    case "run": {
      if (row.status !== "active") throw new Error("sensor is not active");
      if (
        row.last_run_at &&
        Date.now() - new Date(row.last_run_at).valueOf() < MANUAL_RUN_MIN_GAP_MS
      )
        throw new Error("this sensor ran less than a minute ago");
      return await update("run_requested_by=$3, next_run_at=now()", [
        account_id,
      ]);
    }
    case "delete": {
      await db.query(
        "DELETE FROM agent_sensors WHERE sensor_id=$1 AND project_id=$2",
        [row.sensor_id, project_id],
      );
      return { deleted: row.sensor_id };
    }
  }
  throw new Error("unsupported sensor operation");
}

/**
 * The destination host asks this before it executes a queued sensor wake:
 * the sensor must still be active, unchanged, and approved by the account
 * the turn runs as, which must still have access to the project.
 */
export async function authorizeSensorExecutionLocal(
  account_id: string,
  project_id: string,
  host_id: string,
  authorization: SensorExecutionAuthorization,
): Promise<void> {
  requireUuid(host_id, "host_id");
  if (authorization?.version !== 1)
    throw new Error("invalid sensor execution authorization");
  requireUuid(authorization.sensor_id, "sensor_id");
  if (authorization.project_id !== project_id)
    throw new Error("invalid sensor execution authorization");
  await assertProjectHostAgentTokenAccess({ account_id, host_id, project_id });
  const row = await loadForProject(authorization.sensor_id, project_id);
  if (
    row.status !== "active" ||
    row.agent_id !== authorization.agent_id ||
    row.script_hash !== authorization.script_hash ||
    row.approved_by !== account_id
  )
    throw new Error("sensor is no longer active as approved");
  await assertActor(account_id, project_id);
  await assertSensorAgent(row.agent_id);
}
