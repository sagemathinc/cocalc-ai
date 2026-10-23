/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Sensors: scripts an agent proposes and a person approves, which CoCalc runs
// on a schedule and which may wake the agent. These records live on the
// project's bay, next to the agent identity they belong to. Every function
// here runs on that bay; callers route there first (see sensor-routing.ts).

import { createHash, randomUUID } from "node:crypto";
import { requireUuid, type AgentIdentity } from "@cocalc/conat/agents/protocol";
import {
  SENSOR_LIMITS,
  sensorSpecCanonicalJson,
  validateSensorSpec,
  validateSensorWatch,
  sensorKind,
  type AgentSensor,
  type AgentSensorRequest,
  type AgentSensorRun,
  type SensorControlRequest,
  type SensorDeliveryBinding,
  type SensorExecutionAuthorization,
  type SensorSpec,
} from "@cocalc/conat/agents/sensors";
import { nextSensorRunAt } from "@cocalc/util/ai/sensor-schedule";
import { assertProjectHostAgentTokenAccess } from "@cocalc/server/conat/api/project-host-token-auth";
import { assertActor, assertAgent } from "./access";
import { agentStore, type AgentRun } from "./store";
import { sensorBudget, sensorConnectors } from "./cocalc-connector-routing";
import { NO_SENSORS, sensorLimits } from "./sensor-budget";
import { kickSensorScheduler } from "./sensor-kick";
import type { PoolClient } from "@cocalc/database/pool";

/** People may start a sensor by hand at most this often. */
const MANUAL_RUN_MIN_GAP_MS = 60_000;

export { sensorLimits, type SensorLimits } from "./sensor-budget";

const NO_INTERNET =
  "Sensors need a project with internet access. Upgrade the project's membership to enable internet access, then try again.";

// The agent is told, not the person: a watcher that could never run would
// otherwise be paused on its first run, with a notice nobody can act on.
const CI_WATCH_NEEDS_GITHUB =
  "A ci watcher uses the GitHub connector, which this agent does not have (the person who owns it turns it on in the agent's Connectors menu). Instead, watch the checks with the project's own GitHub login: cocalc sensor watch exit -- gh pr checks <number> --repo <owner/name> --watch";

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

/** SQL: the row is not a watcher that already fired or expired. */
const NOT_DONE_WATCHER =
  "NOT (spec->>'kind' = 'watch' AND next_run_at IS NULL)";

/**
 * A watcher must not be deleted while its wake is being issued or is queued
 * (the agent was busy, so the host holds the turn): deleting it deletes the
 * run that holds the wake's one-time permit (agent_sensor_runs cascades), and
 * the turn then fails with "sensor not found". While the scheduler holds the
 * watcher's lease it may be issuing a wake; once issued, the run says so until
 * the turn starts. A fired watcher already gave back its place in the watcher
 * budget and is removed a day after it fired, so waiting costs nothing.
 */
const WATCHER_RUNNING = `(spec->>'kind' = 'watch' AND lease_id IS NOT NULL
  AND lease_until > now())`;
const WATCHER_WAKE_QUEUED = `(spec->>'kind' = 'watch' AND EXISTS (
  SELECT 1 FROM agent_sensor_runs r
   WHERE r.sensor_id = agent_sensors.sensor_id
     AND r.wake_state IN ('issued', 'deferred', 'combining')
     AND r.started_at > now() - interval '1 day'))`;

/** The condition a sensor delete must meet (exported for the PostgreSQL test). */
export const WATCHER_DELETE_GUARD = `NOT ${WATCHER_RUNNING} AND NOT ${WATCHER_WAKE_QUEUED}`;

const WATCHER_RUNNING_ERROR =
  "This watcher is checking right now and may be waking the agent; try again in a minute.";
const WATCHER_WAKE_QUEUED_ERROR =
  "This watcher already fired and its wake is still queued for the agent; deleting it now would make that turn fail. It no longer counts toward the watcher limit and is removed automatically a day after it fired. Cancelling the queued turn in the chat stops that turn; the watcher then stays, inert and uncounted, until it is removed.";

/**
 * Delete one sensor (matched by `where`) unless it is a watcher whose wake is
 * being issued or is queued. If nothing was deleted, say why; when the state
 * changed in between (e.g. the wake started), try once more.
 */
async function deleteSensorGuarded(
  where: string,
  values: unknown[],
): Promise<{ approved_by: string | null; kind: string | null }> {
  for (let attempt = 0; ; attempt++) {
    const { rows } = await agentStore().query(
      `DELETE FROM agent_sensors WHERE ${where} AND ${WATCHER_DELETE_GUARD}
       RETURNING approved_by, spec->>'kind' AS kind`,
      values,
    );
    if (rows[0]) return rows[0];
    const { rows: state } = await agentStore().query(
      `SELECT ${WATCHER_RUNNING} AS running, ${WATCHER_WAKE_QUEUED} AS queued
         FROM agent_sensors WHERE ${where}`,
      values,
    );
    if (!state[0]) throw new Error("sensor not found");
    if (state[0].queued) throw new Error(WATCHER_WAKE_QUEUED_ERROR);
    if (state[0].running) throw new Error(WATCHER_RUNNING_ERROR);
    if (attempt >= 1) throw new Error(WATCHER_RUNNING_ERROR);
  }
}

export function toSensor(row: any): AgentSensor {
  // A watcher that fired or expired is done, though stored as active.
  const done =
    row.status === "active" &&
    sensorKind(row.spec) === "watch" &&
    row.next_run_at == null;
  return {
    sensor_id: row.sensor_id,
    project_id: row.project_id,
    agent_id: row.agent_id,
    status: done ? "done" : row.status,
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
    connectors: Array.isArray(row.connectors) ? row.connectors : [],
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

/** Watchers are short-lived and counted separately (per agent). */
const NOT_WATCH =
  "COALESCE(spec->>'kind', pending_spec->>'kind', 'script') <> 'watch'";

async function activeCount(
  client: Querier,
  project_id: string,
): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM agent_sensors
     WHERE project_id=$1 AND status='active' AND ${NOT_WATCH}`,
    [project_id],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The project's RootFS image, as the host runs it. */
export async function projectImage(project_id: string): Promise<string> {
  const { rows } = await agentStore().query<{ image: string | null }>(
    "SELECT rootfs_image AS image FROM projects WHERE project_id=$1",
    [project_id],
  );
  return `${rows[0]?.image ?? ""}`;
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
      // A sensor runs with the agent's own access, so its log is the agent's
      // to read, like the output of its own commands.
      runs: await recentRuns(request.sensor_id, 10),
    };
  }
  if (request.op === "pause") {
    // A done watcher (fired or expired) stays done.
    const { rows } = await db.query(
      `UPDATE agent_sensors SET status='paused', pause_reason='Paused by the agent',
         revision=revision+1, updated=now()
       WHERE sensor_id=$1 AND agent_id=$2 AND status='active'
         AND ${NOT_DONE_WATCHER}
       RETURNING *`,
      [request.sensor_id, agent.agent_id],
    );
    if (!rows[0])
      throw new Error(
        "no active sensor with that id (a done watcher can only be deleted)",
      );
    return { sensor: toSensor(rows[0]) };
  }
  if (request.op === "delete") {
    const deleted = await deleteSensorGuarded("sensor_id=$1 AND agent_id=$2", [
      request.sensor_id,
      agent.agent_id,
    ]);
    if (deleted.kind === "watch")
      await releaseWatcher(deleted.approved_by, request.sensor_id);
    return { deleted: request.sensor_id };
  }
  // Code running in a sensor run never sets up sensors: no chains of
  // scheduled work without a person or a model turn in between.
  if (await isSensorRun(run.run_id))
    throw new Error("a sensor run cannot set up sensors");
  if (request.op === "watch") return await createWatcher(run, agent, request);
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
         WHERE (SELECT count(*) FROM agent_sensors
                WHERE agent_id=$2 AND ${NOT_WATCH}) < $6
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

/**
 * A built-in watcher: CoCalc's own code, so it is active at once, without
 * approval, as the account of the agent's current turn (which pays for its
 * single wake). It fires once, then deletes itself, or reports expiry.
 */
async function isSensorRun(run_id: string): Promise<boolean> {
  const { rows } = await agentStore().query(
    "SELECT 1 FROM agent_sensor_runs WHERE run_id=$1",
    [run_id],
  );
  return rows.length > 0;
}

async function createWatcher(
  run: AgentRun,
  agent: AgentIdentity,
  request: Extract<AgentSensorRequest, { op: "watch" }>,
) {
  const limits = await sensorLimits(run.account_id);
  // Watchers replace polling: any membership that allows wakes has them,
  // limited by the tier's active watchers (per account and per agent) and
  // the wake budget, not maxActive.
  if (limits.maxWakesPerDay === 0) throw new Error(NO_SENSORS);
  const spec = validateSensorWatch(request.watch, {
    hours: request.hours,
    delivery: request.delivery,
  });
  if (!(await projectHasInternet(agent.project_id)))
    throw new Error(NO_INTERNET);
  if (
    spec.watch.type === "ci" &&
    !(await sensorConnectors.hasCli({
      account_id: run.account_id,
      agent_id: agent.agent_id,
      source_project_id: agent.project_id,
      connector: "github",
    }))
  )
    throw new Error(CI_WATCH_NEEDS_GITHUB);
  const hash = sensorSpecHash(spec);
  const first =
    spec.watch.type === "at"
      ? new Date(spec.watch.at)
      : new Date(Date.now() + 30_000);
  const sensor_id = randomUUID();
  // Counted on the account's home bay, whichever bay this project is on: a
  // few active at once, refused once the day's wakes are used up, and a
  // generous daily cap against churn. Finishing or deleting a watcher never
  // resets the daily counts.
  await sensorBudget.reserveWatcher({
    account_id: run.account_id,
    project_id: agent.project_id,
    agent_id: agent.agent_id,
    sensor_id,
    expires_at: spec.expires_at,
    ...(spec.watch.type === "at" ? { reminder: true } : {}),
  });
  let rows: any[];
  try {
    ({ rows } = await agentStore().query(
      `INSERT INTO agent_sensors (sensor_id, project_id, agent_id, status,
         spec, script_hash, revision, approved_by, approved_at, next_run_at,
         consecutive_failures, wakes_today)
       VALUES ($1, $2, $3, 'active', $4, $5, 1, $6, now(), $7, 0, 0)
       RETURNING *`,
      [
        sensor_id,
        agent.project_id,
        agent.agent_id,
        spec,
        hash,
        run.account_id,
        first,
      ],
    ));
  } catch (err) {
    // No watcher exists, so it is certainly not active.
    await releaseWatcher(run.account_id, sensor_id);
    throw err;
  }
  return {
    sensor: toSensor(rows[0]),
    message:
      spec.watch.type === "at"
        ? `Set. You will get a [Reminder] turn at ${spec.watch.at}. You can end your turn now.`
        : `Watching. You will get one [Sensor wake] turn when it happens, or when it expires at ${spec.expires_at}. You can end your turn now.`,
  };
}

/**
 * A person sets up a scheduled prompt for an agent directly: they are the
 * approver, so it is active at once (like the old thread automations).
 */
async function createScheduledPrompt(
  account_id: string,
  project_id: string,
  request: Extract<SensorControlRequest, { op: "create-prompt" }>,
) {
  requireUuid(request.agent_id, "agent_id");
  const agent = await agentStore().get(request.agent_id);
  if (agent.project_id !== project_id) throw new Error("agent not found");
  await assertAgent(agent);
  const limits = await sensorLimits(account_id);
  if (limits.maxActive === 0) throw new Error(NO_SENSORS);
  const spec = validateSensorSpec(request.spec, {
    minIntervalMinutes: limits.minIntervalMinutes,
    maxWakesPerDay: Math.max(1, limits.maxWakesPerDay),
  });
  if (spec.kind !== "prompt")
    throw new Error("people create scheduled prompts; agents propose scripts");
  if (!(await projectHasInternet(project_id))) throw new Error(NO_INTERNET);
  const next = nextSensorRunAt(spec.schedule, Date.now());
  const { rows } = await agentStore().transaction(async (client) => {
    await lockProjectSensors(client, project_id);
    if ((await activeCount(client, project_id)) >= limits.maxActive)
      throw new Error(
        `This project already has ${limits.maxActive} active sensors, the most your membership allows. Pause or delete one first.`,
      );
    return await client.query(
      `INSERT INTO agent_sensors (sensor_id, project_id, agent_id, status,
         spec, script_hash, revision, approved_by, approved_at, next_run_at,
         approved_image, consecutive_failures, wakes_today)
       VALUES (gen_random_uuid(), $1, $2, 'active', $3, $4, 1, $5, now(), $6,
         $7, 0, 0)
       RETURNING *`,
      [
        project_id,
        agent.agent_id,
        spec,
        sensorSpecHash(spec),
        account_id,
        next ? new Date(next) : null,
        await projectImage(project_id),
      ],
    );
  });
  return { sensor: toSensor(rows[0]) };
}

/**
 * Is this run of one of the agent's sensors live right now, as the account
 * that approved it? The account's home bay asks this before it issues the
 * run's connector credentials, in place of checking a live chat turn.
 */
async function verifySensorRunLocal(
  account_id: string,
  project_id: string,
  agent_id: string,
  run_id: string,
): Promise<{ live: true }> {
  requireUuid(agent_id, "agent_id");
  requireUuid(run_id, "run_id");
  const { rows } = await agentStore().query(
    `SELECT 1 FROM agent_sensor_runs r JOIN agent_sensors s ON s.sensor_id=r.sensor_id
     WHERE r.run_id=$1 AND s.agent_id=$2 AND s.project_id=$3
       AND s.approved_by=$4 AND s.status='active' AND s.lease_id=r.run_id
       AND r.script_hash=s.script_hash AND r.started_at >= s.approved_at
       AND r.finished_at IS NULL AND r.started_at > now() - interval '15 minutes'`,
    [run_id, agent_id, project_id, account_id],
  );
  if (!rows[0]) throw new Error("sensor run is not live");
  return { live: true };
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
  // Watchers are CoCalc's own fixed code and schedule.
  if (sensorKind(spec) !== "watch")
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
  if (request.op === "verify-run")
    return await verifySensorRunLocal(
      account_id,
      project_id,
      request.agent_id,
      request.run_id,
    );
  await assertActor(account_id, project_id);
  const db = agentStore();
  if (request.op === "create-prompt")
    return await createScheduledPrompt(account_id, project_id, request);
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
    /** Approve or resume: wakes from the earlier approval never run. */
    newApproval = false,
    /** A condition that must still hold when the row is updated. */
    stillTrue?: string,
  ) => {
    await beforeManageUpdateHook?.();
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
      const updated = await client.query(
        `UPDATE agent_sensors SET ${sql}, revision=revision+1, updated=now()
         WHERE sensor_id=$1 AND revision=$2${stillTrue ? ` AND (${stillTrue})` : ""}
         RETURNING *`,
        [row.sensor_id, row.revision, ...values],
      );
      if (newApproval && updated.rows[0])
        await client.query(
          `UPDATE agent_sensor_runs SET wake_state='superseded',
             wake_permit_hash=NULL, wake_data=NULL
           WHERE sensor_id=$1
             AND wake_state IN ('issued', 'deferred', 'combining')`,
          [row.sensor_id],
        );
      return updated;
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
      // A script runs in the project's software: the approval is for this image.
      return await update(
        `spec=pending_spec, script_hash=pending_hash, pending_spec=NULL,
         pending_hash=NULL, proposed_at=NULL, proposed_run_id=NULL,
         status='active', approved_by=$3, approved_at=now(), pause_reason=NULL,
         consecutive_failures=0, next_run_at=$4, approved_image=$5`,
        [
          account_id,
          next ? new Date(next) : null,
          await projectImage(project_id),
        ],
        maxActive,
        true,
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
    case "pause": {
      if (toSensor(row).status === "done")
        throw new Error("this watcher is done; delete it instead");
      if (row.status !== "active") throw new Error("sensor is not active");
      // The scheduler finishes a watcher without changing its revision, so
      // "not done" is checked again in the update itself.
      const paused = await update(
        "status='paused', pause_reason='Paused by a person'",
        [],
        undefined,
        false,
        NOT_DONE_WATCHER,
      );
      // A paused watcher can never be resumed: give back its place.
      if (row.spec?.kind === "watch")
        await releaseWatcher(row.approved_by, row.sensor_id);
      return paused;
    }
    case "resume": {
      if (row.status !== "paused" || !row.spec)
        throw new Error("only a paused, approved sensor can be resumed");
      // A watcher's place in its account's budget is held only until it is
      // done or expires, so it never comes back: the agent sets a new one.
      if (row.spec.kind === "watch")
        throw new Error(
          "a watcher cannot be resumed; ask the agent to set a new one",
        );
      const maxActive = await assertCanActivate(account_id, row, row.spec);
      const next = nextSensorRunAt(row.spec.schedule, Date.now());
      // Whoever resumes takes over the approval: runs and wakes are theirs,
      // in the project's current software.
      return await update(
        `status='active', pause_reason=NULL, consecutive_failures=0,
         approved_by=$3, approved_at=now(), next_run_at=$4, approved_image=$5`,
        [
          account_id,
          next ? new Date(next) : null,
          await projectImage(project_id),
        ],
        maxActive,
        true,
      );
    }
    case "run": {
      if (row.status !== "active") throw new Error("sensor is not active");
      if (row.spec?.kind === "watch" && row.next_run_at == null)
        throw new Error("this watcher is done");
      if (
        row.last_run_at &&
        Date.now() - new Date(row.last_run_at).valueOf() < MANUAL_RUN_MIN_GAP_MS
      )
        throw new Error("this sensor ran less than a minute ago");
      const requested = await update("run_requested_by=$3, next_run_at=now()", [
        account_id,
      ]);
      kickSensorScheduler();
      return requested;
    }
    case "delete": {
      await deleteSensorGuarded("sensor_id=$1 AND project_id=$2", [
        row.sensor_id,
        project_id,
      ]);
      if (row.spec?.kind === "watch")
        await releaseWatcher(row.approved_by, row.sensor_id);
      return { deleted: row.sensor_id };
    }
  }
  throw new Error("unsupported sensor operation");
}

/**
 * A watcher fired, gave up or was deleted: it no longer counts as active in
 * its account's budget. A lost release only keeps it counted until it
 * expires, so failures are not errors.
 */
export async function releaseWatcher(
  account_id: string | null | undefined,
  sensor_id: string,
): Promise<void> {
  if (!account_id) return;
  await sensorBudget
    .releaseWatcher({ account_id, sensor_id })
    .catch(() => undefined);
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
  // check_only (a wake about to join a running turn) runs the same checks
  // without consuming: the permit is consumed once the wake was injected,
  // or by its own turn if it could not join one.
  const { rows: consumed } = await agentStore().query(
    `${
      delivery.check_only === true
        ? `SELECT r.run_id FROM agent_sensor_runs r,
             agent_sensors s, agent_identities i, projects p`
        : `UPDATE agent_sensor_runs r SET wake_state='consumed'
             FROM agent_sensors s, agent_identities i, projects p`
    }
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
     ${delivery.check_only === true ? "" : "RETURNING r.run_id"}`,
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

let beforeManageUpdateHook: (() => Promise<void>) | undefined;
/** Tests only: run something between a manage op's checks and its update. */
export function setSensorManageHookForTests(
  hook: (() => Promise<void>) | undefined,
) {
  beforeManageUpdateHook = hook;
}
