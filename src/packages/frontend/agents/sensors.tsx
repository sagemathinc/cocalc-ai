/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// An agent's sensors. A sensor is the agent on a schedule, without the model:
// it runs with the access you gave the agent, and wakes it with a normal turn.
// - Scripts the agent proposes run only after you approve the exact code.
// - Scheduled prompts are turns you schedule (or approve).
// - Watchers are CoCalc's own one-shot checks the agent sets itself.

import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Spin,
  Tag,
} from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  SENSOR_CONNECTOR_LABELS,
  type AgentSensor,
  type AgentSensorRun,
  type ScriptSensorSpec,
  type SensorManageOp,
  type SensorSpec,
} from "@cocalc/conat/agents/sensors";
import { describeSensorSchedule } from "@cocalc/util/ai/sensor-schedule";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { TimeAgo } from "@cocalc/frontend/components";
import { CodeMirrorStatic } from "@cocalc/frontend/jupyter/codemirror-static";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { personalAgentApi } from "./api";
import { SensorReviewPanel } from "./sensor-review-panel";

const LANGUAGE: Record<ScriptSensorSpec["language"], string> = {
  sh: "Shell (bash)",
  python: "Python 3",
  node: "JavaScript (Node.js)",
};

const STATUS_COLOR: Record<AgentSensor["status"], string> = {
  pending: "gold",
  active: "green",
  paused: "default",
  rejected: "red",
  done: "default",
};

const OUTCOME: Record<string, string> = {
  quiet: "Nothing to report",
  wake: "Woke the agent",
  "wake-limited": "Wanted to wake; daily limit reached",
  "wake-failed": "Wake failed",
  "wake-coalesced": "Held while an earlier wake waited; goes with the next",
  failed: "Failed",
  timeout: "Timed out",
  skipped: "Skipped",
};

/** Specs from before kinds are scripts. */
function kindOf(spec: SensorSpec): SensorSpec["kind"] {
  return (spec as any).kind ?? "script";
}

const KIND_LABEL: Record<SensorSpec["kind"], string> = {
  script: "script",
  prompt: "scheduled prompt",
  watch: "watcher",
};

export function sensorAccessText(spec: SensorSpec): string {
  if (kindOf(spec) !== "script") return "";
  const uses = (spec as ScriptSensorSpec).uses ?? [];
  return uses.length > 0
    ? `This project's files and software, and ${uses
        .map((c) => SENSOR_CONNECTOR_LABELS[c])
        .join(", ")}`
    : "This project's files and software only";
}

const CODEMIRROR_MODE: Record<string, string> = {
  sh: "shell",
  python: "python",
  node: "javascript",
};

function CodeBlock({
  label,
  children,
  language,
}: {
  label: string;
  children: string;
  language?: string;
}) {
  const mode = language ? CODEMIRROR_MODE[language] : undefined;
  if (mode)
    return (
      <div
        aria-label={label}
        tabIndex={0}
        style={{ maxHeight: 320, overflow: "auto", fontSize: 12 }}
      >
        <CodeMirrorStatic
          value={children}
          options={{ mode, lineNumbers: false, lineWrapping: true }}
          font_size={12}
        />
      </div>
    );
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      style={{
        maxHeight: 320,
        overflow: "auto",
        fontSize: 12,
        background: UI_COLORS.codeBg,
        color: UI_COLORS.codeText,
        padding: 8,
        borderRadius: 4,
        whiteSpace: "pre-wrap",
      }}
    >
      {children}
    </pre>
  );
}

function watchText(spec: Extract<SensorSpec, { kind: "watch" }>): string {
  const w = spec.watch;
  if (w.type === "ci") return `CI checks on ${w.repo}#${w.pr} finish`;
  if (w.type === "file")
    return w.match ? `${w.path} contains "${w.match}"` : `${w.path} exists`;
  if (w.type === "exit") return `${w.command} exits`;
  return `${new Date(w.at).toLocaleString()}: ${w.note}`;
}

function SpecDetails({ spec }: { spec: SensorSpec }) {
  // Few people read the code; the review summarizes it.
  const [showScript, setShowScript] = useState(false);
  const kind = kindOf(spec);
  if (kind === "watch") {
    const watch = spec as Extract<SensorSpec, { kind: "watch" }>;
    return (
      <Descriptions
        size="small"
        column={1}
        items={[
          { key: "when", label: "Wakes once when", children: watchText(watch) },
          {
            key: "expires",
            label: "Gives up",
            children: new Date(watch.expires_at).toLocaleString(),
          },
        ]}
      />
    );
  }
  if (kind === "prompt") {
    const prompt = spec as Extract<SensorSpec, { kind: "prompt" }>;
    return (
      <>
        <Descriptions
          size="small"
          column={1}
          items={[
            {
              key: "schedule",
              label: "Schedule",
              children: describeSensorSchedule(prompt.schedule),
            },
          ]}
        />
        <CodeBlock label="Prompt">{prompt.prompt}</CodeBlock>
      </>
    );
  }
  const script = spec as ScriptSensorSpec;
  const access = sensorAccessText(script);
  const lines = script.script.trimEnd().split("\n").length;
  return (
    <>
      <Descriptions
        size="small"
        column={1}
        items={[
          { key: "purpose", label: "Purpose", children: script.purpose },
          {
            key: "runs",
            label: "Runs",
            children: `${describeSensorSchedule(script.schedule)}, up to ${script.timeout_seconds} s each`,
          },
          {
            key: "access",
            label: "Access",
            children: `As you, with ${access[0].toLowerCase()}${access.slice(1)}`,
          },
          {
            key: "wakes",
            label: "Wakes",
            children: `At most ${script.max_wakes_per_day} times a day, each a turn on your account`,
          },
          {
            key: "script",
            label: "Script",
            children: (
              <Button
                size="small"
                type="link"
                style={{ padding: 0, height: "auto" }}
                aria-expanded={showScript}
                onClick={() => setShowScript(!showScript)}
              >
                {showScript ? "Hide" : "Show"} {LANGUAGE[script.language]},{" "}
                {lines} {lines === 1 ? "line" : "lines"}
              </Button>
            ),
          },
        ]}
      />
      {showScript && (
        <CodeBlock
          label={`${LANGUAGE[script.language]} script`}
          language={script.language}
        >
          {script.script}
        </CodeBlock>
      )}
    </>
  );
}

/** How long the log watches for a requested run before it gives up. */
const RUN_WATCH_MS = 3 * 60_000;
const RUN_POLL_MS = 2_000;

function Runs({
  sensor,
  requested,
  onSettled,
}: {
  sensor: AgentSensor;
  /** Run now was pressed: when the server took the request. */
  requested?: { at: string };
  /** The requested run finished (or never showed up in time). */
  onSettled?: () => void;
}) {
  const [runs, setRuns] = useState<AgentSensorRun[]>();
  const [error, setError] = useState("");
  const load = async () => {
    setError("");
    try {
      const result = await personalAgentApi().listSensors({
        project_id: sensor.project_id,
        sensor_id: sensor.sensor_id,
      });
      setRuns(result.runs ?? []);
      return result.runs ?? [];
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    }
  };
  // A run that finishes while the log is open shows up in it (while a
  // requested run is followed, that loop loads).
  useEffect(() => {
    if (!requested) void load();
  }, [sensor.last_run_at]);
  // After Run now, open the log and follow the run until it is done.
  // The run it asked for: a manual run started after the request, not one
  // that was already running when Run now was pressed.
  const isNew = (run: AgentSensorRun) =>
    requested != null &&
    run.manual &&
    new Date(run.started_at).valueOf() >= new Date(requested.at).valueOf();
  useEffect(() => {
    if (!requested) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const until = Date.now() + RUN_WATCH_MS;
    const look = async () => {
      const latest = await load();
      if (stopped) return;
      const run = latest?.find(isNew);
      if ((run && run.outcome) || Date.now() > until) onSettled?.();
      else timer = setTimeout(() => void look(), RUN_POLL_MS);
    };
    void look();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [requested]);
  const starting = requested != null && !runs?.some(isNew);
  if (error) return <Alert type="error" title={error} />;
  if (!runs)
    return starting ? <StartingRun /> : <Spin aria-label="Loading runs" />;
  if (runs.length === 0 && !starting)
    return (
      <Empty
        description={
          sensor.next_run_at &&
          new Date(sensor.next_run_at).valueOf() <= Date.now()
            ? "No runs yet; one is starting now"
            : "No runs yet"
        }
      />
    );
  return (
    <div style={{ width: "100%" }}>
      {starting && <StartingRun />}
      {runs.map((run) => (
        <details key={run.run_id} style={{ marginBottom: 4 }}>
          <summary>
            <TimeAgo date={run.started_at} />
            {" · "}
            {run.outcome ? (
              (OUTCOME[run.outcome] ?? run.outcome)
            ) : (
              <>
                <Spin size="small" /> Running
              </>
            )}
            {run.manual ? " · run by hand" : ""}
            {run.summary ? ` · ${run.summary}` : ""}
          </summary>
          {run.error && (
            <div style={{ color: UI_COLORS.danger }}>{run.error}</div>
          )}
          {run.connectors?.length > 0 && (
            <div>
              Used{" "}
              {run.connectors.map((c) => SENSOR_CONNECTOR_LABELS[c]).join(", ")}
            </div>
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

function StartingRun() {
  return (
    <div role="status" style={{ marginBottom: 4 }}>
      <Spin size="small" /> Starting the run…
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
  const [requested, setRequested] = useState<{ at: string }>();
  const [logOpen, setLogOpen] = useState(false);
  const spec = sensor.spec ?? sensor.pending_spec!;
  const kind = kindOf(spec);
  const act = async (op: SensorManageOp) => {
    setBusy(op);
    setError("");
    try {
      const result = await personalAgentApi().manageSensor({
        project_id: sensor.project_id,
        sensor_id: sensor.sensor_id,
        op,
        revision: sensor.revision,
      });
      // The run log opens and follows the run it asked for. The request's
      // time is the database's, like the run's start.
      if (op === "run") {
        setRequested({
          at: result?.sensor?.updated ?? new Date().toISOString(),
        });
        setLogOpen(true);
      }
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
  const pending = sensor.pending_spec;
  const deleteButton = (
    <Popconfirm
      title="Delete this sensor and its run log?"
      okText="Delete"
      onConfirm={() => void act("delete")}
    >
      <Button size="small" danger type="text" disabled={busy != null}>
        Delete
      </Button>
    </Popconfirm>
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
        <Tag>{KIND_LABEL[kind]}</Tag>
        <Tag color={STATUS_COLOR[sensor.status]}>{sensor.status}</Tag>
        {pending && sensor.spec && <Tag color="gold">change to review</Tag>}
      </Space>
      {error && (
        <Alert
          type="error"
          title={error}
          showIcon
          style={{ marginBottom: 8 }}
        />
      )}
      {pending && (
        <div style={{ marginBottom: 8 }}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            title={
              sensor.spec
                ? `@${agent.name} proposed a change. The approved version keeps running until you approve it.`
                : `@${agent.name} proposed this. Nothing runs until you approve it.`
            }
            description={
              kindOf(pending) === "script"
                ? undefined
                : `It starts a turn of @${agent.name} with this prompt on this schedule, paid by your account.`
            }
          />
          <SpecDetails spec={pending} />
          {kindOf(pending) === "script" && sensor.pending_hash && (
            <SensorReviewPanel
              agent={agent}
              sensor={sensor}
              spec={pending as ScriptSensorSpec}
              hash={sensor.pending_hash}
            />
          )}
          <Space wrap>
            {button("approve", "Approve and run", true)}
            {button("reject", "Reject")}
            {sensor.spec ? (
              <Button size="small" onClick={() => setShowCurrent(!showCurrent)}>
                {showCurrent
                  ? "Hide approved version"
                  : "Show approved version"}
              </Button>
            ) : (
              deleteButton
            )}
          </Space>
        </div>
      )}
      {sensor.spec && (!pending || showCurrent) && (
        <SpecDetails spec={sensor.spec} />
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
              {new Date(sensor.next_run_at).valueOf() <= Date.now() ? (
                "Next run: starting now"
              ) : (
                <>
                  Next run <TimeAgo date={sensor.next_run_at} />
                </>
              )}
            </div>
          )}
          {kind !== "watch" && (
            <div>
              Woke the agent {sensor.wakes_today} of{" "}
              {sensor.spec.max_wakes_per_day} times today (UTC)
            </div>
          )}
        </div>
      )}
      {/* A proposal that never ran has only its own buttons. */}
      {!(pending && !sensor.spec) && (
        <Space wrap>
          {sensor.status === "active" && button("run", "Run now")}
          {sensor.status === "active" && button("pause", "Pause")}
          {sensor.status === "paused" &&
            sensor.spec &&
            kind !== "watch" &&
            button("resume", "Resume")}
          {deleteButton}
          {sensor.spec && (
            <Button
              size="small"
              aria-expanded={logOpen}
              onClick={() => setLogOpen(!logOpen)}
            >
              {logOpen ? "Hide log" : "Show log"}
            </Button>
          )}
        </Space>
      )}
      {sensor.spec && logOpen && (
        <div style={{ marginTop: 8 }}>
          <Runs
            sensor={sensor}
            requested={requested}
            onSettled={() => {
              setRequested(undefined);
              onChanged();
            }}
          />
        </div>
      )}
    </section>
  );
}

const WEEKDAYS = [1, 2, 3, 4, 5];

/** A person schedules a prompt for the agent: the old thread automation. */
function SchedulePromptForm({
  agent,
  onDone,
}: {
  agent: NamedAgent;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"daily" | "interval">("daily");
  const [times, setTimes] = useState("07:00");
  const [minutes, setMinutes] = useState<number | null>(60);
  const [weekdays, setWeekdays] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const days = weekdays ? { days: WEEKDAYS } : {};
      await personalAgentApi().createScheduledPrompt({
        project_id: agent.endpoint.project_id,
        agent_id: agent.endpoint.agent_id,
        spec: {
          kind: "prompt",
          title,
          prompt,
          schedule:
            kind === "daily"
              ? {
                  kind: "daily",
                  times: times
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                  timezone,
                  ...days,
                }
              : { kind: "interval", minutes: minutes ?? 0, timezone, ...days },
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-label="Schedule a prompt"
      style={{
        border: `1px solid ${UI_COLORS.border}`,
        borderRadius: 6,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <label>
          Title
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Morning briefing"
          />
        </label>
        <label>
          Prompt
          <Input.TextArea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 10 }}
            placeholder="Summarize today's calendar, open PRs and new support tickets."
          />
        </label>
        <Radio.Group
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="Schedule"
        >
          <Radio value="daily">Daily at</Radio>
          <Radio value="interval">Every</Radio>
        </Radio.Group>
        {kind === "daily" ? (
          <label>
            Times ({timezone}), separated by commas
            <Input value={times} onChange={(e) => setTimes(e.target.value)} />
          </label>
        ) : (
          <label>
            Minutes between turns
            <InputNumber
              min={1}
              value={minutes}
              onChange={(value) => setMinutes(value)}
              style={{ display: "block" }}
            />
          </label>
        )}
        <Checkbox
          checked={weekdays}
          onChange={(e) => setWeekdays(e.target.checked)}
        >
          Weekdays only
        </Checkbox>
        {error && <Alert type="error" title={error} showIcon />}
        <Space>
          <Button
            type="primary"
            loading={saving}
            disabled={!title.trim() || !prompt.trim()}
            onClick={() => void save()}
          >
            Schedule
          </Button>
          <Button onClick={onDone}>Cancel</Button>
        </Space>
      </Space>
    </section>
  );
}

/**
 * A sensor that will never run again: a watcher that fired or gave up, one
 * paused past its give-up time, or a rejected proposal. They are removed
 * after a day; until then they stay out of the way.
 */
export function sensorFinished(sensor: AgentSensor, now = Date.now()): boolean {
  if (sensor.status === "done" || sensor.status === "rejected") return true;
  const spec = sensor.spec as { kind?: string; expires_at?: string } | null;
  return (
    sensor.status === "paused" &&
    spec?.kind === "watch" &&
    spec.expires_at != null &&
    Date.parse(spec.expires_at) <= now
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
  const [creating, setCreating] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  const current = sensors?.filter((sensor) => !sensorFinished(sensor));
  const finished = sensors?.filter((sensor) => sensorFinished(sensor)) ?? [];
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
        A sensor is @{agent.name} on a schedule, without the model. It runs with
        the access you gave @{agent.name} (its Connectors menu) and wakes it
        with a normal turn, paid by you. Scripts the agent proposes run only
        after you approve the exact code. Sensors need a project with internet
        access.
      </p>
      {!creating && (
        <Button style={{ marginBottom: 12 }} onClick={() => setCreating(true)}>
          Schedule a prompt
        </Button>
      )}
      {creating && (
        <SchedulePromptForm
          agent={agent}
          onDone={() => {
            setCreating(false);
            void refresh();
          }}
        />
      )}
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
      {sensors?.length === 0 && !creating && (
        <Empty
          description={`@${agent.name} has no sensors yet. Schedule a prompt, or ask it to watch for something.`}
        />
      )}
      {sensors && sensors.length > 0 && current?.length === 0 && (
        <p style={{ color: UI_COLORS.secondary }}>
          Nothing is watching or scheduled for @{agent.name} right now.
        </p>
      )}
      {current?.map((sensor) => (
        <SensorCard
          key={sensor.sensor_id}
          agent={agent}
          sensor={sensor}
          onChanged={() => void refresh()}
        />
      ))}
      {finished.length > 0 && (
        <Button
          type="link"
          style={{ paddingInline: 0 }}
          aria-expanded={showFinished}
          onClick={() => setShowFinished((value) => !value)}
        >
          {showFinished
            ? "Hide finished"
            : `Show ${finished.length} finished (fired, given up or rejected)`}
        </Button>
      )}
      {showFinished &&
        finished.map((sensor) => (
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
