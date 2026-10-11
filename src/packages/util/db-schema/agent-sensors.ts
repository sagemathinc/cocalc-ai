/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";
import type { FieldSpec } from "./types";

// Sensors: approved scripts that run on a schedule and may wake an agent.
// Owned by the project's bay like the agent identity they belong to; no
// user/project query exposure, all access goes through the sensor API.
const required = (type: FieldSpec["type"], desc: string): FieldSpec => ({
  type,
  not_null: true,
  desc,
});
const timestamp = (desc: string): FieldSpec => ({
  type: "timestamp",
  pg_type: "TIMESTAMPTZ",
  desc,
});
const json = (desc: string): FieldSpec => ({
  type: "map",
  pg_type: "JSONB",
  desc,
});

Table({
  name: "agent_sensors",
  rules: {
    primary_key: "sensor_id",
    pg_constraints: [
      {
        name: "agent_sensors_agent_id_fkey",
        type: "foreign-key",
        columns: ["agent_id"],
        references: { table: "agent_identities", columns: ["agent_id"] },
        on_delete: "cascade",
      },
      {
        name: "agent_sensors_status_check",
        type: "check",
        expression: "status IN ('pending','active','paused','rejected')",
      },
    ],
    pg_custom_indexes: [
      { name: "agent_sensors_agent", query: "(agent_id)" },
      { name: "agent_sensors_project", query: "(project_id)" },
      {
        name: "agent_sensors_due",
        query: "(next_run_at) WHERE status = 'active'",
      },
    ],
  },
  fields: {
    sensor_id: required("uuid", "Stable sensor id."),
    project_id: required("uuid", "Project owned by this bay."),
    agent_id: required("uuid", "Agent the sensor belongs to and wakes."),
    status: required(
      "string",
      "pending (never approved), active, paused or rejected.",
    ),
    spec: json(
      "Approved spec (kind script, prompt or watch, with its schedule and limits); null until first approval.",
    ),
    script_hash: {
      type: "string",
      desc: "SHA-256 of the canonical approved spec.",
    },
    pending_spec: json("Proposed spec awaiting human approval."),
    pending_hash: {
      type: "string",
      desc: "SHA-256 of the canonical pending spec.",
    },
    proposed_at: timestamp("When the pending spec was proposed."),
    proposed_run_id: {
      type: "uuid",
      desc: "Agent run that proposed the pending spec.",
    },
    revision: required(
      "integer",
      "Increases on every change; approvals must name the revision they saw.",
    ),
    approved_by: {
      type: "uuid",
      desc: "Human who approved the active spec; wakes run as this account.",
    },
    approved_at: timestamp("When the active spec was approved."),
    approved_image: {
      type: "string",
      desc: "The project's RootFS image when the sensor was approved or resumed; a script sensor pauses if it changes.",
    },
    pause_reason: { type: "string", desc: "Why the sensor is paused." },
    next_run_at: timestamp("Next scheduled run."),
    lease_until: timestamp("A scheduler holds this sensor until then."),
    lease_id: { type: "uuid", desc: "Run id of the current lease." },
    last_run_at: timestamp("Start of the last run."),
    last_outcome: { type: "string", desc: "Outcome of the last run." },
    last_wake_at: timestamp("Last time the sensor woke its agent."),
    consecutive_failures: required(
      "integer",
      "Failed runs in a row; reaching the limit pauses the sensor.",
    ),
    wakes_day: {
      type: "string",
      desc: "UTC date (YYYY-MM-DD) that wakes_today counts.",
    },
    wakes_today: required("integer", "Wakes delivered on wakes_day."),
    run_requested_by: {
      type: "uuid",
      desc: "Human who asked for a run now; cleared when it starts.",
    },
    created: {
      ...timestamp("Creation time."),
      not_null: true,
      pg_default: "now()",
    },
    updated: {
      ...timestamp("Last change."),
      not_null: true,
      pg_default: "now()",
    },
  },
});

Table({
  name: "agent_sensor_runs",
  rules: {
    primary_key: "run_id",
    pg_constraints: [
      {
        name: "agent_sensor_runs_sensor_id_fkey",
        type: "foreign-key",
        columns: ["sensor_id"],
        references: { table: "agent_sensors", columns: ["sensor_id"] },
        on_delete: "cascade",
      },
    ],
    pg_custom_indexes: [
      { name: "agent_sensor_runs_sensor", query: "(sensor_id,started_at)" },
      { name: "agent_sensor_runs_project", query: "(project_id)" },
    ],
  },
  fields: {
    run_id: required("uuid", "Run id."),
    sensor_id: required("uuid", "Sensor that ran."),
    project_id: required("uuid", "Project, for hard deletion."),
    script_hash: { type: "string", desc: "Hash of the spec that ran." },
    started_at: {
      ...timestamp("Run start."),
      not_null: true,
      pg_default: "now()",
    },
    finished_at: timestamp("Run end."),
    outcome: {
      type: "string",
      desc: "quiet, wake, wake-limited, wake-failed, wake-coalesced (held while an earlier wake was queued), failed, timeout or skipped.",
    },
    exit_code: { type: "integer", desc: "Script exit code." },
    summary: { type: "string", desc: "Wake summary, when the script woke." },
    output: {
      type: "string",
      desc: "Truncated script output for the owner's log; never shown to the agent.",
    },
    error: { type: "string", desc: "Why the run failed or was skipped." },
    manual: { type: "boolean", desc: "Started by a person with run now." },
    wake_permit_hash: {
      type: "string",
      desc: "SHA-256 of the one-time secret that authorizes this run's wake turn.",
    },
    wake_prompt_sha256: {
      type: "string",
      desc: "SHA-256 of the exact prompt the wake may run.",
    },
    wake_account_id: {
      type: "uuid",
      desc: "Account the wake turn must run as (the approver).",
    },
    wake_path: { type: "string", desc: "Chat the wake turn must run in." },
    wake_thread_id: {
      type: "string",
      desc: "Thread the wake turn must run in.",
    },
    wake_state: {
      type: "string",
      desc: "issued, then consumed when the turn starts executing, or not-sent when the host certainly wrote nothing (the permit is then void); deferred while an earlier wake of the sensor was queued, combining while a later wake that carries it is sent, then combined; superseded when the sensor is approved or resumed again (the permit is then void).",
    },
    wake_data: json(
      "A deferred wake (summary and data), until a later wake includes it.",
    ),
    combined_into: {
      type: "uuid",
      desc: "The run whose wake included this deferred one.",
    },
    connectors: {
      type: "array",
      pg_type: "TEXT[]",
      desc: "Connectors whose credentials this run was given (cocalc, github, cloudflare).",
    },
  },
});

// Each account's sensor budgets, on the account's home bay so they hold
// across all bays its projects are on: wakes and watcher creations in the
// last 24 hours, and active watchers. Kept apart from the sensors, so
// deleting a sensor (or a watcher finishing) never resets a daily budget.
Table({
  name: "agent_sensor_events",
  rules: {
    primary_key: "event_id",
    pg_custom_indexes: [
      {
        name: "agent_sensor_events_account",
        query: "(account_id,kind,created)",
      },
    ],
  },
  fields: {
    event_id: required(
      "uuid",
      "The sensor run for a wake, the sensor for a watcher.",
    ),
    kind: required("string", "wake or watch (a watcher was set)."),
    account_id: required(
      "uuid",
      "The account the wake runs as, or that set the watcher.",
    ),
    project_id: required("uuid", "Project of the sensor (information only)."),
    agent_id: required("uuid", "Agent."),
    sensor_id: { type: "uuid", desc: "Sensor, if it still exists." },
    created: {
      ...timestamp("When it happened."),
      not_null: true,
      pg_default: "now()",
    },
    expires_at: timestamp(
      "Watchers: counts as active until then, unless released first.",
    ),
    released_at: timestamp("Watchers: when it fired, gave up or was deleted."),
  },
});
