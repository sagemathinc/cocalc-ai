/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// An agent's sensors: scripts it proposed that CoCalc runs on a schedule and
// that may wake it. People review and approve the exact script here; nothing
// runs before that.

import { useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
} from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type {
  AgentSensor,
  AgentSensorRun,
  SensorManageOp,
  SensorSpec,
} from "@cocalc/conat/agents/sensors";
import { describeSensorSchedule } from "@cocalc/util/ai/sensor-schedule";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { TimeAgo } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { personalAgentApi } from "./api";

const LANGUAGE: Record<SensorSpec["language"], string> = {
  sh: "Shell (bash)",
  python: "Python 3",
  node: "JavaScript (Node.js)",
};

const STATUS_COLOR: Record<AgentSensor["status"], string> = {
  pending: "gold",
  active: "green",
  paused: "default",
  rejected: "red",
};

const OUTCOME: Record<string, string> = {
  quiet: "Nothing to report",
  wake: "Woke the agent",
  "wake-limited": "Wanted to wake; daily limit reached",
  "wake-failed": "Wake failed",
  failed: "Failed",
  timeout: "Timed out",
  skipped: "Skipped",
};

function ScriptBlock({ spec }: { spec: SensorSpec }) {
  return (
    <pre
      aria-label={`${LANGUAGE[spec.language]} script`}
      tabIndex={0}
      style={{
        maxHeight: 320,
        overflow: "auto",
        fontSize: 12,
        background: UI_COLORS.codeBg,
        color: UI_COLORS.codeText,
        padding: 8,
        borderRadius: 4,
        whiteSpace: "pre",
      }}
    >
      {spec.script}
    </pre>
  );
}

function SpecDetails({ spec }: { spec: SensorSpec }) {
  return (
    <Descriptions
      size="small"
      column={1}
      items={[
        { key: "purpose", label: "Purpose", children: spec.purpose },
        {
          key: "schedule",
          label: "Schedule",
          children: describeSensorSchedule(spec.schedule),
        },
        {
          key: "language",
          label: "Language",
          children: LANGUAGE[spec.language],
        },
        {
          key: "limits",
          label: "Limits",
          children: `${spec.timeout_seconds} s per run, at most ${spec.max_wakes_per_day} wakes per day`,
        },
      ]}
    />
  );
}

function Runs({ sensor }: { sensor: AgentSensor }) {
  const [runs, setRuns] = useState<AgentSensorRun[]>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const load = async () => {
    setOpen(true);
    try {
      const result = await personalAgentApi().listSensors({
        project_id: sensor.project_id,
        sensor_id: sensor.sensor_id,
      });
      setRuns(result.runs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    }
  };
  if (!open)
    return (
      <Button size="small" onClick={() => void load()}>
        Run log
      </Button>
    );
  if (error) return <Alert type="error" title={error} />;
  if (!runs) return <Spin aria-label="Loading runs" />;
  if (runs.length === 0) return <Empty description="No runs yet" />;
  return (
    <div style={{ width: "100%" }}>
      {runs.map((run) => (
        <details key={run.run_id} style={{ marginBottom: 4 }}>
          <summary>
            <TimeAgo date={run.started_at} />
            {" · "}
            {run.outcome ? (OUTCOME[run.outcome] ?? run.outcome) : "Running"}
            {run.manual ? " · run by hand" : ""}
            {run.summary ? ` · ${run.summary}` : ""}
          </summary>
          {run.error && (
            <div style={{ color: UI_COLORS.danger }}>{run.error}</div>
          )}
          {run.output && (
            <pre style={{ maxHeight: 240, overflow: "auto", fontSize: 12 }}>
              {run.output}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}

function SensorCard({
  agent,
  sensor,
  onChanged,
}: {
  agent: NamedAgent;
  sensor: AgentSensor;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<SensorManageOp>();
  const [error, setError] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const spec = sensor.spec ?? sensor.pending_spec!;
  const act = async (op: SensorManageOp) => {
    setBusy(op);
    setError("");
    try {
      await personalAgentApi().manageSensor({
        project_id: sensor.project_id,
        sensor_id: sensor.sensor_id,
        op,
        revision: sensor.revision,
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
      onChanged();
    } finally {
      setBusy(undefined);
    }
  };
  const button = (op: SensorManageOp, label: string, primary = false) => (
    <Button
      size="small"
      type={primary ? "primary" : "default"}
      loading={busy === op}
      disabled={busy != null}
      onClick={() => void act(op)}
    >
      {label}
    </Button>
  );
  return (
    <section
      aria-label={`Sensor ${spec.title}`}
      style={{
        border: `1px solid ${UI_COLORS.border}`,
        borderRadius: 6,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <Space wrap style={{ marginBottom: 8 }}>
        <strong>{spec.title}</strong>
        <Tag color={STATUS_COLOR[sensor.status]}>{sensor.status}</Tag>
        {sensor.pending_spec && sensor.spec && (
          <Tag color="gold">change to review</Tag>
        )}
      </Space>
      {error && (
        <Alert
          type="error"
          title={error}
          showIcon
          style={{ marginBottom: 8 }}
        />
      )}
      {sensor.pending_spec && (
        <div style={{ marginBottom: 8 }}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            title={
              sensor.spec
                ? `@${agent.name} proposed a change. The approved version keeps running until you approve it.`
                : `@${agent.name} proposed this sensor. Nothing runs until you approve it.`
            }
            description="It runs in this project with the project's files and credentials, on the schedule below, and each wake starts a turn paid by your account. Read the script before approving."
          />
          <SpecDetails spec={sensor.pending_spec} />
          <ScriptBlock spec={sensor.pending_spec} />
          <Space>
            {button("approve", "Approve and run", true)}
            {button("reject", "Reject")}
            {sensor.spec && (
              <Button size="small" onClick={() => setShowCurrent(!showCurrent)}>
                {showCurrent
                  ? "Hide approved version"
                  : "Show approved version"}
              </Button>
            )}
          </Space>
        </div>
      )}
      {sensor.spec && (!sensor.pending_spec || showCurrent) && (
        <>
          <SpecDetails spec={sensor.spec} />
          <details style={{ marginBottom: 8 }}>
            <summary>Approved script</summary>
            <ScriptBlock spec={sensor.spec} />
          </details>
        </>
      )}
      {sensor.spec && (
        <div style={{ color: UI_COLORS.secondary, marginBottom: 8 }}>
          {sensor.pause_reason && <div>{sensor.pause_reason}</div>}
          {sensor.last_run_at ? (
            <div>
              Last run <TimeAgo date={sensor.last_run_at} />:{" "}
              {OUTCOME[sensor.last_outcome ?? ""] ?? sensor.last_outcome}
              {sensor.consecutive_failures > 0
                ? ` (${sensor.consecutive_failures} failures in a row)`
                : ""}
            </div>
          ) : (
            <div>Not run yet</div>
          )}
          {sensor.next_run_at && (
            <div>
              Next run <TimeAgo date={sensor.next_run_at} />
            </div>
          )}
          <div>
            Woke the agent {sensor.wakes_today} of{" "}
            {sensor.spec.max_wakes_per_day} times today (UTC)
          </div>
        </div>
      )}
      <Space wrap>
        {sensor.status === "active" && button("run", "Run now")}
        {sensor.status === "active" && button("pause", "Pause")}
        {sensor.status === "paused" &&
          sensor.spec &&
          button("resume", "Resume")}
        <Popconfirm
          title="Delete this sensor and its run log?"
          okText="Delete"
          onConfirm={() => void act("delete")}
        >
          <Button size="small" danger disabled={busy != null}>
            Delete
          </Button>
        </Popconfirm>
        {sensor.spec && <Runs sensor={sensor} />}
      </Space>
    </section>
  );
}

export function AgentSensorsModal({
  agent,
  open,
  onClose,
  sensors,
  error,
  refresh,
}: {
  agent: NamedAgent;
  open: boolean;
  onClose: () => void;
  sensors?: AgentSensor[];
  error: string;
  refresh: () => Promise<void> | void;
}) {
  return (
    <Modal
      open={open}
      title={`Sensors for @${agent.name}`}
      onCancel={onClose}
      footer={null}
      width={720}
      modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
    >
      <p style={{ color: UI_COLORS.secondary }}>
        A sensor is a small script CoCalc runs on a schedule in this project.
        When it finds something, it wakes the agent with a message marked as
        coming from the sensor, not from a person. Ask the agent to propose one,
        for example: "check for new GitHub issues every 30 minutes and triage
        them". Sensors need a project with internet access.
      </p>
      {error && (
        <Alert
          type="error"
          title="Unable to load sensors"
          description={error}
          action={<Button onClick={() => void refresh()}>Retry</Button>}
          style={{ marginBottom: 12 }}
        />
      )}
      {!sensors && !error && <Spin aria-label="Loading sensors" />}
      {sensors?.length === 0 && (
        <Empty description="This agent has no sensors yet." />
      )}
      {sensors?.map((sensor) => (
        <SensorCard
          key={sensor.sensor_id}
          agent={agent}
          sensor={sensor}
          onChanged={() => void refresh()}
        />
      ))}
    </Modal>
  );
}
