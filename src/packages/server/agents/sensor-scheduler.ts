/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Runs due sensors on this bay. Each hub process polls; row leases with
// SKIP LOCKED make sure only one of them runs a given sensor. The project's
// host executes the approved script, and the hub alone decides whether its
// result wakes the agent, so limits never depend on host or project state.

import getLogger from "@cocalc/backend/logger";
import { createHash, randomBytes } from "node:crypto";
import {
  SENSOR_LIMITS,
  parseSensorWake,
  sensorWakePrompt,
  validateSensorSpec,
  type SensorRunOutcome,
  type SensorSpec,
} from "@cocalc/conat/agents/sensors";
import { nextSensorRunAt } from "@cocalc/util/ai/sensor-schedule";
import { assertActor } from "./access";
import { hostFor } from "./rpc";
import {
  projectHasInternet,
  sensorLimits,
  sensorPermitHash,
  sensorSpecHash,
  utcDay,
} from "./sensors";
import { agentStore } from "./store";

const logger = getLogger("agents:sensors");
const POLL_MS = 30_000;
const CLAIM_BATCH = 20;
const CONCURRENCY = 4;
/** Longer than the longest script plus container start and wake delivery. */
const LEASE_MINUTES = 20;

interface ClaimedSensor {
  sensor_id: string;
  project_id: string;
  agent_id: string;
  spec: SensorSpec;
  script_hash: string;
  approved_by: string;
  revision: number;
  lease_id: string;
  wakes_day: string | null;
  wakes_today: number;
  consecutive_failures: number;
  manual_by: string | null;
}

export async function claimDueSensors(
  limit = CLAIM_BATCH,
): Promise<ClaimedSensor[]> {
  const { rows } = await agentStore().query<ClaimedSensor>(
    `WITH due AS (
       SELECT sensor_id, run_requested_by FROM agent_sensors
       WHERE status='active' AND next_run_at<=now()
         AND (lease_until IS NULL OR lease_until<now())
       ORDER BY next_run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE agent_sensors s SET lease_id=gen_random_uuid(),
       lease_until=now()+make_interval(mins => $2), run_requested_by=NULL
     FROM due WHERE s.sensor_id=due.sensor_id
     RETURNING s.*, due.run_requested_by AS manual_by`,
    [limit, LEASE_MINUTES],
  );
  return rows;
}

/** Why this sensor may not run now, if it may not; pausing it is the fix. */
async function pauseReason(row: ClaimedSensor): Promise<string | undefined> {
  if (!row.spec || sensorSpecHash(row.spec) !== row.script_hash)
    return "The approved spec failed its integrity check. Approve it again.";
  const agent = await agentStore()
    .get(row.agent_id)
    .catch(() => undefined);
  if (!agent || agent.disabled_at) return "The agent was disabled.";
  try {
    await assertActor(row.approved_by, row.project_id);
  } catch {
    return "The person who approved this sensor can no longer use the project. A current collaborator must resume it.";
  }
  const limits = await sensorLimits(row.approved_by);
  if (limits.maxActive === 0)
    return "The approver's membership no longer includes sensors.";
  try {
    // Memberships change: the approved schedule must still fit them.
    validateSensorSpec(row.spec, {
      minIntervalMinutes: limits.minIntervalMinutes,
      maxWakesPerDay: Math.max(1, limits.maxWakesPerDay),
    });
  } catch (err) {
    return `The sensor no longer fits the approver's membership: ${errorText(err)}`;
  }
  // Over the active limit after a downgrade, the earliest approved keep running.
  const { rows: kept } = await agentStore().query(
    `SELECT sensor_id FROM agent_sensors WHERE project_id=$1 AND status='active'
     ORDER BY approved_at, sensor_id LIMIT $2`,
    [row.project_id, limits.maxActive],
  );
  if (!kept.some((r) => r.sensor_id === row.sensor_id))
    return `This project has more active sensors than the approver's membership allows (${limits.maxActive}).`;
  if (!(await projectHasInternet(row.project_id)))
    return "The project no longer has internet access.";
  return undefined;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : `${error}`;
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

function logOutput(stdout: string, stderr: string): string {
  const half = Math.floor(SENSOR_LIMITS.maxLogBytes / 2);
  const tail = (text: string) =>
    text.length > half ? `…${text.slice(text.length - half)}` : text;
  return [
    stdout && `stdout:\n${tail(stdout)}`,
    stderr && `stderr:\n${tail(stderr)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runClaimedSensor(row: ClaimedSensor): Promise<void> {
  const db = agentStore();
  const started = new Date();
  const run_id = row.lease_id;
  let outcome: SensorRunOutcome = "failed";
  let failed = true;
  let woke = 0;
  let exit_code: number | null = null;
  let summary: string | null = null;
  let output: string | null = null;
  let error: string | null = null;
  let pause: string | undefined;
  try {
    await db.query(
      // Database time, comparable with approved_at when the wake executes.
      `INSERT INTO agent_sensor_runs (run_id, sensor_id, project_id,
         script_hash, started_at, manual) VALUES ($1,$2,$3,$4,now(),$5)`,
      [run_id, row.sensor_id, row.project_id, row.script_hash, !!row.manual_by],
    );
    pause = await pauseReason(row);
    if (pause) {
      outcome = "skipped";
      failed = false;
      error = pause;
      return;
    }
    const agent = await db.get(row.agent_id);
    const { rows: projects } = await db.query<{ image: string | null }>(
      "SELECT rootfs_image AS image FROM projects WHERE project_id=$1",
      [row.project_id],
    );
    const host = await hostFor({
      project_id: row.project_id,
      agent_id: row.agent_id,
    });
    const result = await host.api.runAgentSensor({
      project_id: row.project_id,
      sensor_id: row.sensor_id,
      run_id,
      language: row.spec.language,
      script: row.spec.script,
      timeout_seconds: row.spec.timeout_seconds,
      path: agent.path,
      image: projects[0]?.image ?? "",
    });
    exit_code = result.exit_code;
    output = logOutput(result.stdout, result.stderr);
    if (result.timed_out) {
      outcome = "timeout";
      error = `The script ran longer than ${row.spec.timeout_seconds} seconds.`;
      return;
    }
    if (exit_code !== 0) {
      error = `The script exited with code ${exit_code}.`;
      return;
    }
    let wake;
    try {
      wake = parseSensorWake(result.stdout);
    } catch (err) {
      error = errorText(err);
      return;
    }
    failed = false;
    if (!wake) {
      outcome = "quiet";
      return;
    }
    summary = wake.summary;
    const day = utcDay(started);
    const today = row.wakes_day === day ? row.wakes_today : 0;
    const limits = await sensorLimits(row.approved_by);
    if (today >= Math.min(row.spec.max_wakes_per_day, limits.maxWakesPerDay)) {
      outcome = "wake-limited";
      return;
    }
    try {
      const prompt = sensorWakePrompt({
        title: row.spec.title,
        sensor_id: row.sensor_id,
        ran_at: started,
        wake,
      });
      // A one-time secret for exactly this wake: the turn it starts must run
      // this prompt, in this thread, as the approver. Only its hash is kept.
      const permit = randomBytes(32).toString("base64url");
      await db.query(
        `UPDATE agent_sensor_runs SET wake_permit_hash=$2,
           wake_prompt_sha256=$3, wake_account_id=$4, wake_path=$5,
           wake_thread_id=$6, wake_state='issued'
         WHERE run_id=$1`,
        [
          run_id,
          sensorPermitHash(permit),
          createHash("sha256").update(prompt).digest("hex"),
          row.approved_by,
          agent.path,
          agent.thread_id,
        ],
      );
      await host.api.deliverAgentSensorWake({
        account_id: row.approved_by,
        path: agent.path,
        thread_id: agent.thread_id,
        title: row.spec.title,
        prompt,
        authorization: {
          version: 1,
          sensor_id: row.sensor_id,
          project_id: row.project_id,
          agent_id: row.agent_id,
          script_hash: row.script_hash,
          run_id,
          permit,
        },
      });
      outcome = "wake";
      woke = 1;
    } catch (err) {
      outcome = "wake-failed";
      failed = true;
      error = `The wake could not start a turn: ${errorText(err)}`;
    }
  } catch (err) {
    error = errorText(err);
  } finally {
    const failures = failed ? row.consecutive_failures + 1 : 0;
    if (!pause && failures >= SENSOR_LIMITS.maxConsecutiveFailures)
      pause = `Paused after ${failures} failed runs in a row. Last error: ${error ?? outcome}`;
    const next =
      nextSensorRunAt(row.spec.schedule, Date.now()) ??
      Date.now() + 24 * 60 * 60_000;
    const day = utcDay(started);
    await db
      .query(
        `UPDATE agent_sensors SET lease_id=NULL, lease_until=NULL,
           last_run_at=$3, last_outcome=$4, consecutive_failures=$5,
           wakes_today=(CASE WHEN wakes_day=$6 THEN wakes_today ELSE 0 END)+$7,
           wakes_day=$6,
           last_wake_at=CASE WHEN $7=1 THEN now() ELSE last_wake_at END,
           next_run_at=CASE WHEN revision=$8 THEN $9 ELSE next_run_at END,
           status=CASE WHEN $10::text IS NOT NULL AND status='active'
             THEN 'paused' ELSE status END,
           pause_reason=CASE WHEN $10::text IS NOT NULL AND status='active'
             THEN $10 ELSE pause_reason END,
           revision=CASE WHEN $10::text IS NOT NULL AND status='active'
             THEN revision+1 ELSE revision END,
           updated=now()
         WHERE sensor_id=$1 AND lease_id=$2`,
        [
          row.sensor_id,
          run_id,
          started,
          outcome,
          failures,
          day,
          woke,
          row.revision,
          new Date(next),
          pause ?? null,
        ],
      )
      .catch((err) =>
        logger.warn("could not record sensor run", {
          sensor_id: row.sensor_id,
          err: errorText(err),
        }),
      );
    await db
      .query(
        `UPDATE agent_sensor_runs SET finished_at=now(), outcome=$2,
           exit_code=$3, summary=$4, output=$5, error=$6 WHERE run_id=$1`,
        [run_id, outcome, exit_code, summary, output, error],
      )
      .then(() =>
        db.query(
          `DELETE FROM agent_sensor_runs WHERE sensor_id=$1 AND run_id NOT IN
           (SELECT run_id FROM agent_sensor_runs WHERE sensor_id=$1
            ORDER BY started_at DESC LIMIT $2)`,
          [row.sensor_id, SENSOR_LIMITS.keepRuns],
        ),
      )
      .catch(() => undefined);
    if (pause)
      logger.info("sensor paused", { sensor_id: row.sensor_id, pause });
  }
}

export function startSensorScheduler(): () => void {
  if (process.env.COCALC_SENSORS_DISABLED === "1") return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    if (stopped) return;
    try {
      const due = await claimDueSensors();
      const queue = [...due];
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          for (let row = queue.shift(); row; row = queue.shift()) {
            await runClaimedSensor(row).catch((err) =>
              logger.warn("sensor run failed", {
                sensor_id: row?.sensor_id,
                err: errorText(err),
              }),
            );
          }
        }),
      );
    } catch (err) {
      logger.warn("sensor scheduler tick failed", { err: errorText(err) });
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, POLL_MS);
        timer.unref();
      }
    }
  };
  timer = setTimeout(tick, POLL_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
