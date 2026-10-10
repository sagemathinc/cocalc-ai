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
  type AgentSensorRunSummary,
  type SensorControlRequest,
  type SensorDeliveryBinding,
  type SensorExecutionAuthorization,
  type SensorSpec,
} from "@cocalc/conat/agents/sensors";
import { nextSensorRunAt } from "@cocalc/util/ai/sensor-schedule";
import { getAccountProductAccessTrust } from "@cocalc/server/accounts/trusted-product-access";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { assertProjectHostAgentTokenAccess } from "@cocalc/server/conat/api/project-host-token-auth";
import { assertActor, assertAgent } from "./access";
import { agentStore, type AgentRun } from "./store";
import type { PoolClient } from "@cocalc/database/pool";

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

/** Runs as an agent may see them: no output or errors, which may hold secrets. */
export function toAgentRunSummary(run: AgentSensorRun): AgentSensorRunSummary {
  const {
    run_id,
    started_at,
    finished_at,
    outcome,
    exit_code,
    summary,
    manual,
  } = run;
  return {
    run_id,
    started_at,
    finished_at,
    outcome,
    exit_code,
    summary,
    manual,
  };
}

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

type Querier = Pick<PoolClient, "query">;

/**
 * Serialize quota-checked changes to one project's sensors, so concurrent
 * approvals or proposals cannot all see room under a limit.
 */
async function lockProjectSensors(client: Querier, project_id: string) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('agent-sensors:' || $1::text, 0))",
    [project_id],
  );
}

async function activeCount(
  client: Querier,
  project_id: string,
): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
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
      runs: (await recentRuns(request.sensor_id, 10)).map(toAgentRunSummary),
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
    const { rows } = await db.transaction(async (client) => {
      await lockProjectSensors(client, agent.project_id);
      return await client.query(
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
    });
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

/**
 * Checks that must hold whenever a person makes a sensor active, except the
 * active count, which the activating transaction checks under a lock.
 * Returns the approver's limit on active sensors.
 */
async function assertCanActivate(
  account_id: string,
  row: any,
  spec: SensorSpec,
): Promise<number> {
  const limits = await sensorLimits(account_id);
  if (limits.maxActive === 0) throw new Error(NO_SENSORS);
  // The approver's own membership limits apply: their account pays for wakes.
  validateSensorSpec(spec, {
    minIntervalMinutes: limits.minIntervalMinutes,
    maxWakesPerDay: Math.max(1, limits.maxWakesPerDay),
  });
  if (!(await projectHasInternet(row.project_id))) throw new Error(NO_INTERNET);
  await assertSensorAgent(row.agent_id);
  return limits.maxActive;
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
      request.delivery,
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
  // Revision CAS on every change. Activations also take the project's sensor
  // lock and count active sensors inside the same transaction.
  const update = async (
    sql: string,
    values: unknown[],
    activateWithin?: number,
  ) => {
    const { rows } = await db.transaction(async (client) => {
      if (activateWithin !== undefined) {
        await lockProjectSensors(client, project_id);
        if (
          row.status !== "active" &&
          (await activeCount(client, project_id)) >= activateWithin
        )
          throw new Error(
            `This project already has ${activateWithin} active sensors, the most your membership allows. Pause or delete one first.`,
          );
      }
      return await client.query(
        `UPDATE agent_sensors SET ${sql}, revision=revision+1, updated=now()
         WHERE sensor_id=$1 AND revision=$2 RETURNING *`,
        [row.sensor_id, row.revision, ...values],
      );
    });
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
      const maxActive = await assertCanActivate(account_id, row, spec);
      const next = nextSensorRunAt(spec.schedule, Date.now());
      return await update(
        `spec=pending_spec, script_hash=pending_hash, pending_spec=NULL,
         pending_hash=NULL, proposed_at=NULL, proposed_run_id=NULL,
         status='active', approved_by=$3, approved_at=now(), pause_reason=NULL,
         consecutive_failures=0, next_run_at=$4`,
        [account_id, next ? new Date(next) : null],
        maxActive,
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
      const maxActive = await assertCanActivate(account_id, row, row.spec);
      const next = nextSensorRunAt(row.spec.schedule, Date.now());
      // Whoever resumes takes over the approval: wakes run as them.
      return await update(
        `status='active', pause_reason=NULL, consecutive_failures=0,
         approved_by=$3, approved_at=now(), next_run_at=$4`,
        [account_id, next ? new Date(next) : null],
        maxActive,
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

export function sensorPermitHash(permit: string): string {
  return createHash("sha256").update(permit).digest("hex");
}

/**
 * The destination host asks this before it executes a queued sensor wake.
 * The wake's one-time permit must match the one the scheduler issued for
 * that run, bound to the exact prompt, chat thread and account; it is
 * consumed here, so it can authorize one turn only. The sensor must still be
 * active as approved and its approver must still have access to the project.
 */
export async function authorizeSensorExecutionLocal(
  account_id: string,
  project_id: string,
  host_id: string,
  authorization: SensorExecutionAuthorization,
  delivery: SensorDeliveryBinding,
): Promise<void> {
  const denied = () => new Error("sensor wake is not authorized");
  requireUuid(host_id, "host_id");
  if (
    authorization?.version !== 1 ||
    authorization.project_id !== project_id ||
    typeof authorization.permit !== "string" ||
    authorization.permit.length < 32 ||
    typeof delivery?.prompt_sha256 !== "string" ||
    typeof delivery.path !== "string" ||
    typeof delivery.thread_id !== "string"
  )
    throw denied();
  requireUuid(authorization.sensor_id, "sensor_id");
  requireUuid(authorization.run_id, "run_id");
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
  const agent = await agentStore().get(row.agent_id);
  await assertAgent(agent);
  if (agent.path !== delivery.path || agent.thread_id !== delivery.thread_id)
    throw denied();
  await beforeConsumeHook?.();
  // The checks above give clear errors; this one statement is what counts.
  // It re-checks everything it authorizes (sensor still active with this
  // hash, approver and approval, identity thread, project membership and
  // host) and consumes the permit, so a pause, re-approval, disable, thread
  // change or loss of access committed before it leaves nothing to consume.
  const { rows: consumed } = await agentStore().query(
    `UPDATE agent_sensor_runs r SET wake_state='consumed'
     FROM agent_sensors s, agent_identities i, projects p
     WHERE r.run_id=$1 AND r.sensor_id=$2 AND r.wake_state='issued'
       AND r.wake_permit_hash=$3 AND r.wake_prompt_sha256=$4
       AND r.wake_account_id=$5 AND r.wake_path=$6 AND r.wake_thread_id=$7
       AND r.started_at > now() - interval '1 day'
       AND s.sensor_id=r.sensor_id AND s.project_id=$8 AND s.status='active'
       AND s.agent_id=$9 AND s.script_hash=$10 AND r.script_hash=s.script_hash
       AND s.approved_by=$5 AND r.started_at >= s.approved_at
       AND i.agent_id=s.agent_id AND i.disabled_at IS NULL
       AND i.path=$6 AND i.thread_id=$7
       AND p.project_id=s.project_id AND p.deleted IS NOT TRUE
       AND p.host_id=$11
       AND p.users #>> ARRAY[$5::text, 'group'] IN ('owner', 'collaborator')
     RETURNING r.run_id`,
    [
      authorization.run_id,
      authorization.sensor_id,
      sensorPermitHash(authorization.permit),
      delivery.prompt_sha256,
      account_id,
      delivery.path,
      delivery.thread_id,
      project_id,
      authorization.agent_id,
      authorization.script_hash,
      host_id,
    ],
  );
  if (consumed.length !== 1) throw denied();
}

let beforeConsumeHook: (() => Promise<void>) | undefined;
/** Tests only: run something between the checks and the consuming update. */
export function setSensorConsumeHookForTests(
  hook: (() => Promise<void>) | undefined,
) {
  beforeConsumeHook = hook;
}
