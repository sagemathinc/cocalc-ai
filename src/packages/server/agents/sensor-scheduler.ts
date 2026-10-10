/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Runs due sensors on this bay. Each hub process polls; row leases with
// SKIP LOCKED make sure only one of them runs a given sensor.
// - script sensors and ci/file watchers: the project's host runs the code in
//   the project's own software, with credentials issued for this run only
//   (sensor-credentials.ts), and the hub alone decides whether the result
//   wakes the agent, so limits never depend on host or project state;
// - scheduled prompts and reminders: no code runs; the hub starts the turn.

import getLogger from "@cocalc/backend/logger";
import { createHash, randomBytes } from "node:crypto";
import {
  SENSOR_CONNECTOR_LABELS,
  SENSOR_LIMITS,
  parseSensorWake,
  reminderText,
  scheduledPromptText,
  sensorKind,
  sensorUses,
  sensorWakePrompt,
  sensorWatchScript,
  validateSensorSpec,
  type SensorRunOutcome,
  type SensorSpec,
  type SensorWake,
} from "@cocalc/conat/agents/sensors";
import { nextSensorRunAt } from "@cocalc/util/ai/sensor-schedule";
import { assertActor } from "./access";
import { hostFor } from "./rpc";
import { issueSensorRunCredentials } from "./sensor-credentials";
import {
  projectHasInternet,
  projectImage,
  releaseWake,
  reserveWake,
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
  /** Exact (microsecond) text, to compare in SQL. */
  approved_at_text: string;
  approved_image: string | null;
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
     RETURNING s.*, s.approved_at::text AS approved_at_text,
       due.run_requested_by AS manual_by`,
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
  const kind = sensorKind(row.spec);
  if (kind !== "watch") {
    try {
      // Memberships change: the approved schedule must still fit them.
      validateSensorSpec(row.spec, {
        minIntervalMinutes: limits.minIntervalMinutes,
        maxWakesPerDay: Math.max(1, limits.maxWakesPerDay),
      });
    } catch (err) {
      return `The sensor no longer fits the approver's membership: ${errorText(err)}`;
    }
    // Over the active limit after a downgrade, the earliest approved keep
    // running. Watchers are short-lived and limited per agent instead.
    const { rows: kept } = await agentStore().query(
      `SELECT sensor_id FROM agent_sensors WHERE project_id=$1 AND status='active'
         AND COALESCE(spec->>'kind', 'script') <> 'watch'
       ORDER BY approved_at, sensor_id LIMIT $2`,
      [row.project_id, limits.maxActive],
    );
    if (!kept.some((r) => r.sensor_id === row.sensor_id))
      return `This project has more active sensors than the approver's membership allows (${limits.maxActive}).`;
  }
  if (
    kind === "script" &&
    row.approved_image != null &&
    row.approved_image !== (await projectImage(row.project_id))
  )
    return "The project's software (its RootFS image) changed since this sensor was approved. Review it and resume it to run it in the new software.";
  if (!(await projectHasInternet(row.project_id)))
    return "The project no longer has internet access.";
  return undefined;
}

/**
 * The sensor as claimed is still what may run: active, the same approved
 * spec, approver and approval, and (for scripts) the project's software is
 * still the approved image. One statement, checked right before credentials
 * are issued and again right before dispatch; returns the image to run.
 */
async function currentDispatch(
  row: ClaimedSensor,
): Promise<{ image: string } | undefined> {
  const { rows } = await agentStore().query<{ image: string }>(
    `SELECT COALESCE(p.rootfs_image, '') AS image
     FROM agent_sensors s JOIN projects p ON p.project_id=s.project_id
     WHERE s.sensor_id=$1 AND s.lease_id=$2 AND s.status='active'
       AND s.script_hash=$3 AND s.approved_by=$4 AND s.approved_at::text=$5
       AND p.deleted IS NOT TRUE
       AND (COALESCE(s.spec->>'kind', 'script') <> 'script'
            OR s.approved_image IS NULL
            OR s.approved_image = COALESCE(p.rootfs_image, ''))`,
    [
      row.sensor_id,
      row.lease_id,
      row.script_hash,
      row.approved_by,
      row.approved_at_text,
    ],
  );
  return rows[0];
}

/** Why the claimed sensor may no longer run: pause it if that is the fix. */
async function changedReason(row: ClaimedSensor): Promise<string | undefined> {
  const { rows } = await agentStore().query(
    "SELECT *, approved_at::text AS approved_at_text FROM agent_sensors WHERE sensor_id=$1",
    [row.sensor_id],
  );
  const current = rows[0];
  if (!current || current.status !== "active") return undefined;
  return await pauseReason({ ...row, ...current });
}

let beforeDispatchHook: (() => Promise<void>) | undefined;
/** Tests only: run something between credential issuance and dispatch. */
export function setSensorDispatchHookForTests(
  hook: (() => Promise<void>) | undefined,
) {
  beforeDispatchHook = hook;
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
  // A watcher that has fired (or expired) is done: never scheduled again.
  let finished = false;
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
    const spec = row.spec;
    const changed = async () => {
      pause = await changedReason(row);
      outcome = "skipped";
      failed = false;
      error = pause ?? "The sensor changed before it ran.";
      finished = false;
    };
    if (!(await currentDispatch(row))) {
      await changed();
      return;
    }
    const agent = await db.get(row.agent_id);
    const host = await hostFor({
      project_id: row.project_id,
      agent_id: row.agent_id,
    });
    let prompt: string | undefined;
    if (spec.kind === "prompt") {
      prompt = scheduledPromptText({
        title: spec.title,
        sensor_id: row.sensor_id,
        prompt: spec.prompt,
      });
      summary = "Scheduled prompt";
    } else if (spec.kind === "watch" && spec.watch.type === "at") {
      prompt = reminderText({
        sensor_id: row.sensor_id,
        note: spec.watch.note,
        at: spec.watch.at,
      });
      summary = spec.watch.note;
      finished = true;
    } else if (
      spec.kind === "watch" &&
      Date.now() >= Date.parse(spec.expires_at)
    ) {
      const wake: SensorWake = {
        summary: `Gave up: "${spec.title}" did not happen before ${spec.expires_at}.`,
      };
      prompt = sensorWakePrompt({
        title: spec.title,
        sensor_id: row.sensor_id,
        ran_at: started,
        wake,
      });
      summary = wake.summary;
      finished = true;
    } else {
      // Code runs: an approved script, or a ci/file watcher's built-in one.
      const watch = spec.kind === "watch" ? spec.watch : undefined;
      const script = watch ? sensorWatchScript(watch) : (spec as any).script;
      if (!script) throw new Error("this watcher has nothing to run");
      const timeout_seconds = watch
        ? SENSOR_LIMITS.defaultTimeoutSeconds
        : (spec as any).timeout_seconds;
      const lease = await issueSensorRunCredentials({
        agent,
        account_id: row.approved_by,
        host_id: host.host_id,
        run_id,
        uses: sensorUses(spec),
      });
      let result;
      try {
        if (lease.missing.length > 0) {
          const names = lease.missing
            .map((c) => SENSOR_CONNECTOR_LABELS[c])
            .join(" and ");
          pause = `This sensor uses ${names}, which the person who approved it has not turned on for this agent (its Connectors menu). Turn it on, then resume the sensor.`;
          outcome = "skipped";
          failed = false;
          error = pause;
          return;
        }
        const renewal = setInterval(
          () =>
            void lease.renew().catch((err) =>
              logger.warn("sensor connector renewal failed", {
                run_id,
                err: errorText(err),
              }),
            ),
          60_000,
        );
        try {
          await beforeDispatchHook?.();
          // Checked again now that credentials exist, and the exact image
          // checked is the one run.
          const dispatch = await currentDispatch(row);
          if (!dispatch) {
            await changed();
            return;
          }
          result = await host.api.runAgentSensor({
            project_id: row.project_id,
            sensor_id: row.sensor_id,
            run_id,
            language: watch ? "python" : (spec as any).language,
            script,
            timeout_seconds,
            path: agent.path,
            image: dispatch.image,
            credentials: lease.credentials,
          });
        } finally {
          clearInterval(renewal);
        }
      } finally {
        await lease.release();
      }
      exit_code = result.exit_code;
      output = logOutput(result.stdout, result.stderr);
      if (result.timed_out) {
        outcome = "timeout";
        error = `The script ran longer than ${timeout_seconds} seconds.`;
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
      prompt = sensorWakePrompt({
        title: spec.title,
        sensor_id: row.sensor_id,
        ran_at: started,
        wake,
      });
      finished = !!watch;
    }
    failed = false;
    if (!(await currentDispatch(row))) {
      await changed();
      return;
    }
    const day = utcDay(started);
    const today = row.wakes_day === day ? row.wakes_today : 0;
    const limits = await sensorLimits(row.approved_by);
    // This sensor's own limit, and the approver's budget across all their
    // sensors and watchers (which a deleted or finished sensor cannot reset).
    const reservation =
      today < spec.max_wakes_per_day
        ? await reserveWake({
            account_id: row.approved_by,
            project_id: row.project_id,
            agent_id: row.agent_id,
            sensor_id: row.sensor_id,
            limit: limits.maxWakesPerDay,
          })
        : undefined;
    if (!reservation) {
      outcome = "wake-limited";
      finished = false;
      return;
    }
    try {
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
        title: spec.title,
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
      finished = false;
      error = `The wake could not start a turn: ${errorText(err)}`;
      await releaseWake(reservation).catch(() => undefined);
    }
  } catch (err) {
    error = errorText(err);
  } finally {
    await finishRun(row, {
      run_id,
      started,
      outcome,
      failed,
      woke,
      exit_code,
      summary,
      output,
      error,
      pause,
      finished,
    });
  }
}

async function finishRun(
  row: ClaimedSensor,
  r: {
    run_id: string;
    started: Date;
    outcome: SensorRunOutcome;
    failed: boolean;
    woke: number;
    exit_code: number | null;
    summary: string | null;
    output: string | null;
    error: string | null;
    pause: string | undefined;
    finished: boolean;
  },
): Promise<void> {
  const db = agentStore();
  let pause = r.pause;
  const failures = r.failed ? row.consecutive_failures + 1 : 0;
  if (!pause && failures >= SENSOR_LIMITS.maxConsecutiveFailures)
    pause = `Paused after ${failures} failed runs in a row. Last error: ${r.error ?? r.outcome}`;
  await db
    .query(
      `UPDATE agent_sensor_runs SET finished_at=now(), outcome=$2,
         exit_code=$3, summary=$4, output=$5, error=$6 WHERE run_id=$1`,
      [r.run_id, r.outcome, r.exit_code, r.summary, r.output, r.error],
    )
    .catch(() => undefined);
  // A watcher fires once. It stays active (its queued wake is authorized
  // against it) with no next run, and is removed a day later.
  const next = r.finished
    ? null
    : (nextSensorRunAt(row.spec.schedule, Date.now()) ??
      Date.now() + 24 * 60 * 60_000);
  const day = utcDay(r.started);
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
        r.run_id,
        r.started,
        r.outcome,
        failures,
        day,
        r.woke,
        row.revision,
        next == null ? null : new Date(next),
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
      `DELETE FROM agent_sensor_runs WHERE sensor_id=$1 AND run_id NOT IN
       (SELECT run_id FROM agent_sensor_runs WHERE sensor_id=$1
        ORDER BY started_at DESC LIMIT $2)`,
      [row.sensor_id, SENSOR_LIMITS.keepRuns],
    )
    .catch(() => undefined);
  if (pause) logger.info("sensor paused", { sensor_id: row.sensor_id, pause });
}

/** Watchers that fired more than a day ago; their wakes have long run. */
export async function removeDoneWatchers(): Promise<void> {
  await agentStore().query(
    `DELETE FROM agent_sensors WHERE spec->>'kind'='watch'
       AND next_run_at IS NULL AND lease_id IS NULL
       AND last_run_at < now() - interval '1 day'`,
  );
  // Budgets look back one day.
  await agentStore().query(
    "DELETE FROM agent_sensor_events WHERE created < now() - interval '2 days'",
  );
}

export function startSensorScheduler(): () => void {
  if (process.env.COCALC_SENSORS_DISABLED === "1") return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    if (stopped) return;
    try {
      await removeDoneWatchers();
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
