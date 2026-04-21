/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Input, InputNumber, Select, Space, Switch } from "antd";
import type {
  AcpAutomationConfig,
  AcpAutomationState,
} from "@cocalc/conat/ai/acp/types";
import { Tooltip } from "@cocalc/frontend/components/tip";

const DEFAULT_LOCAL_TIME = "05:00";
const DEFAULT_INTERVAL_MINUTES = 120;
const DEFAULT_WINDOW_START_LOCAL_TIME = "00:00";
const DEFAULT_WINDOW_END_LOCAL_TIME = "23:59";
const DEFAULT_RANGE_START_LOCAL_TIME = "06:00";
const DEFAULT_RANGE_END_LOCAL_TIME = "20:00";
const DEFAULT_PAUSE_AFTER_RUNS = 7;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_COMMAND_MAX_OUTPUT_BYTES = 250_000;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const DAY_SHORT_LABELS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const DAY_LONG_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function resolvedTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function normalizeTimeString(value?: string): string | undefined {
  const raw = `${value ?? ""}`.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}`;
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map((x) => Number(x));
  return hour * 60 + minute;
}

function normalizeDaysOfWeek(value?: unknown): number[] {
  if (!Array.isArray(value)) {
    return [...ALL_DAYS];
  }
  const days = [...new Set(value.map((day) => Number(day)))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((left, right) => left - right);
  return days.length > 0 ? days : [...ALL_DAYS];
}

function summarizeDays(days?: number[]): string | undefined {
  const normalized = normalizeDaysOfWeek(days);
  if (normalized.length === ALL_DAYS.length) {
    return undefined;
  }
  if (`${normalized}` === "1,2,3,4,5") {
    return "Mon-Fri";
  }
  return normalized.map((day) => DAY_LONG_LABELS[day].slice(0, 3)).join(", ");
}

function intervalLabel(minutes?: number): string {
  const value = Number(minutes ?? DEFAULT_INTERVAL_MINUTES);
  if (!Number.isFinite(value) || value <= 0) {
    return `Every ${DEFAULT_INTERVAL_MINUTES} min`;
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return `Every ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `Every ${value} min`;
}

function isAllDayWindow(config?: AcpAutomationConfig): boolean {
  return (
    (config?.window_start_local_time ?? DEFAULT_WINDOW_START_LOCAL_TIME) ===
      DEFAULT_WINDOW_START_LOCAL_TIME &&
    (config?.window_end_local_time ?? DEFAULT_WINDOW_END_LOCAL_TIME) ===
      DEFAULT_WINDOW_END_LOCAL_TIME
  );
}

export function hasAutomationConfigContent(
  config?: AcpAutomationConfig,
): boolean {
  return !!(
    config &&
    (config.automation_id ||
      config.prompt ||
      config.command ||
      config.title ||
      config.command_cwd ||
      config.command_timeout_ms ||
      config.command_max_output_bytes ||
      config.local_time ||
      config.interval_minutes ||
      config.window_start_local_time ||
      config.window_end_local_time ||
      config.timezone ||
      (Array.isArray(config.days_of_week) && config.days_of_week.length > 0))
  );
}

export function describeAutomationSchedule(
  config?: AcpAutomationConfig,
): string | undefined {
  if (!config) return undefined;
  const timezone = `${config.timezone ?? ""}`.trim();
  const daySummary = summarizeDays(config.days_of_week);
  if (
    config.schedule_type === "interval" &&
    config.interval_minutes != null &&
    config.window_start_local_time &&
    config.window_end_local_time
  ) {
    const prefix = daySummary ? `${daySummary} ` : "";
    if (isAllDayWindow(config)) {
      return `${prefix}${intervalLabel(config.interval_minutes)} all day${
        timezone ? ` ${timezone}` : ""
      }`;
    }
    return `${prefix}${intervalLabel(config.interval_minutes)} from ${
      config.window_start_local_time
    } to ${config.window_end_local_time}${timezone ? ` ${timezone}` : ""}`;
  }
  if (config.local_time) {
    const prefix = daySummary ? `${daySummary} at ` : "Daily at ";
    return `${prefix}${config.local_time}${timezone ? ` ${timezone}` : ""}`;
  }
  return undefined;
}

export function getDefaultAutomationConfig({
  enabled = true,
  prompt,
  runKind = "codex",
}: {
  enabled?: boolean;
  prompt?: string;
  runKind?: "codex" | "command";
} = {}): AcpAutomationConfig {
  return {
    enabled,
    run_kind: runKind,
    schedule_type: "daily",
    days_of_week: [...ALL_DAYS],
    local_time: DEFAULT_LOCAL_TIME,
    interval_minutes: DEFAULT_INTERVAL_MINUTES,
    window_start_local_time: DEFAULT_WINDOW_START_LOCAL_TIME,
    window_end_local_time: DEFAULT_WINDOW_END_LOCAL_TIME,
    timezone: resolvedTimezone(),
    pause_after_unacknowledged_runs: DEFAULT_PAUSE_AFTER_RUNS,
    prompt,
    command_timeout_ms: DEFAULT_COMMAND_TIMEOUT_MS,
    command_max_output_bytes: DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
  };
}

export function buildAutomationDraft({
  config,
  enabled = true,
  promptFallback,
  allowCodexRunKind = true,
}: {
  config?: AcpAutomationConfig;
  enabled?: boolean;
  promptFallback?: string;
  allowCodexRunKind?: boolean;
} = {}): AcpAutomationConfig {
  const base = getDefaultAutomationConfig({
    enabled,
    prompt: promptFallback,
    runKind: allowCodexRunKind ? "codex" : "command",
  });
  const run_kind =
    !allowCodexRunKind || config?.run_kind === "command" ? "command" : "codex";
  return {
    ...base,
    ...(config ?? {}),
    run_kind,
    days_of_week: normalizeDaysOfWeek(config?.days_of_week),
  };
}

function clearedNumber(): number {
  return null as unknown as number;
}

function inputNumberValue({
  draft,
  key,
  fallback,
  scale = 1,
}: {
  draft?: AcpAutomationConfig;
  key: keyof AcpAutomationConfig;
  fallback: number;
  scale?: number;
}): number | null {
  if (draft && key in draft && draft[key] == null) {
    return null;
  }
  const raw = (draft?.[key] as number | undefined) ?? fallback;
  const value = Number(raw) / scale;
  return Number.isFinite(value) ? Math.round(value) : null;
}

export function normalizeAutomationConfigForSave({
  draft,
  automationId,
  allowCodexRunKind = true,
}: {
  draft?: AcpAutomationConfig;
  automationId?: string;
  allowCodexRunKind?: boolean;
}): AcpAutomationConfig | undefined {
  if (!draft) return undefined;
  const run_kind =
    !allowCodexRunKind || draft.run_kind === "command" ? "command" : "codex";
  const prompt = `${draft.prompt ?? ""}`.trim();
  const command = `${draft.command ?? ""}`.trim();
  const command_cwd = `${draft.command_cwd ?? ""}`.trim() || undefined;
  const timezone = `${draft.timezone ?? ""}`.trim() || resolvedTimezone();
  const days_of_week = normalizeDaysOfWeek(draft.days_of_week);
  const pause_after_unacknowledged_runs = Number(
    draft.pause_after_unacknowledged_runs ?? DEFAULT_PAUSE_AFTER_RUNS,
  );
  const schedule_type =
    draft.schedule_type === "interval" ? "interval" : "daily";
  if (!timezone) {
    return undefined;
  }
  if (run_kind === "command") {
    if (!command) return undefined;
  } else if (!prompt) {
    return undefined;
  }
  if (schedule_type === "interval") {
    const window_start_local_time =
      normalizeTimeString(draft.window_start_local_time) ??
      DEFAULT_WINDOW_START_LOCAL_TIME;
    const window_end_local_time =
      normalizeTimeString(draft.window_end_local_time) ??
      DEFAULT_WINDOW_END_LOCAL_TIME;
    if (
      timeToMinutes(window_end_local_time) <=
      timeToMinutes(window_start_local_time)
    ) {
      return undefined;
    }
    return {
      enabled: draft.enabled !== false,
      automation_id: automationId,
      title: `${draft.title ?? ""}`.trim() || undefined,
      run_kind,
      prompt: run_kind === "codex" ? prompt : undefined,
      command: run_kind === "command" ? command : undefined,
      command_cwd,
      command_timeout_ms:
        run_kind === "command"
          ? Math.max(
              1_000,
              Math.min(
                24 * 60 * 60_000,
                Math.round(
                  Number(
                    draft.command_timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
                  ),
                ),
              ),
            )
          : undefined,
      command_max_output_bytes:
        run_kind === "command"
          ? Math.max(
              1_024,
              Math.min(
                10 * 1024 * 1024,
                Math.round(
                  Number(
                    draft.command_max_output_bytes ??
                      DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
                  ),
                ),
              ),
            )
          : undefined,
      schedule_type,
      days_of_week,
      interval_minutes: Math.max(
        5,
        Math.min(
          24 * 60,
          Math.round(
            Number(draft.interval_minutes ?? DEFAULT_INTERVAL_MINUTES),
          ),
        ),
      ),
      window_start_local_time,
      window_end_local_time,
      timezone,
      pause_after_unacknowledged_runs,
    };
  }
  const local_time = normalizeTimeString(draft.local_time);
  if (!local_time) {
    return undefined;
  }
  return {
    enabled: draft.enabled !== false,
    automation_id: automationId,
    title: `${draft.title ?? ""}`.trim() || undefined,
    run_kind,
    prompt: run_kind === "codex" ? prompt : undefined,
    command: run_kind === "command" ? command : undefined,
    command_cwd,
    command_timeout_ms:
      run_kind === "command"
        ? Math.max(
            1_000,
            Math.min(
              24 * 60 * 60_000,
              Math.round(
                Number(draft.command_timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS),
              ),
            ),
          )
        : undefined,
    command_max_output_bytes:
      run_kind === "command"
        ? Math.max(
            1_024,
            Math.min(
              10 * 1024 * 1024,
              Math.round(
                Number(
                  draft.command_max_output_bytes ??
                    DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
                ),
              ),
            ),
          )
        : undefined,
    schedule_type: "daily",
    days_of_week,
    local_time,
    timezone,
    pause_after_unacknowledged_runs,
  };
}

export function formatAutomationPausedReason(
  pausedReason?: string | null,
): string | undefined {
  switch (`${pausedReason ?? ""}`.trim()) {
    case "":
      return undefined;
    case "user_paused":
      return "Paused";
    case "disabled":
      return "Disabled";
    case "unacknowledged_runs_limit":
      return "Paused after unattended runs";
    default:
      return pausedReason ?? undefined;
  }
}

export function shouldShowAutomationNextRun({
  enabled,
  status,
  next_run_at_ms,
}: Pick<AcpAutomationConfig, "enabled"> &
  Pick<AcpAutomationState, "status" | "next_run_at_ms">): boolean {
  if (!next_run_at_ms) {
    return false;
  }
  if (enabled === false) {
    return false;
  }
  return status !== "paused";
}

interface AutomationConfigFieldsProps {
  draft?: AcpAutomationConfig;
  onChange: (patch: Partial<AcpAutomationConfig>) => void;
  disabled?: boolean;
  showEnableToggle?: boolean;
  allowCodexRunKind?: boolean;
  enableLabel?: string;
  titlePlaceholder?: string;
  promptPlaceholder?: string;
}

export function AutomationConfigFields({
  draft,
  onChange,
  disabled = false,
  showEnableToggle = true,
  allowCodexRunKind = true,
  enableLabel = "Enable scheduled automation for this thread",
  titlePlaceholder = "Daily project status",
  promptPlaceholder = "What should Codex do on each scheduled run?",
}: AutomationConfigFieldsProps) {
  const value = buildAutomationDraft({ config: draft, allowCodexRunKind });
  const selectedDays = normalizeDaysOfWeek(value.days_of_week);
  const scheduleType =
    value.schedule_type === "interval" ? "interval" : "daily";
  const runKind =
    !allowCodexRunKind || value.run_kind === "command" ? "command" : "codex";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {showEnableToggle ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Switch
            checked={value.enabled !== false}
            disabled={disabled}
            onChange={(checked) => onChange({ enabled: checked })}
          />
          <span>{enableLabel}</span>
        </div>
      ) : null}
      <label>Title</label>
      <Input
        value={value.title ?? ""}
        disabled={disabled}
        placeholder={titlePlaceholder}
        onChange={(e) => onChange({ title: e.target.value })}
      />
      {allowCodexRunKind ? (
        <>
          <label>Run type</label>
          <Select
            value={runKind}
            disabled={disabled}
            options={[
              { label: "Codex prompt", value: "codex" },
              { label: "Bash command", value: "command" },
            ]}
            onChange={(next) =>
              onChange({
                run_kind: next === "command" ? "command" : "codex",
              })
            }
          />
        </>
      ) : null}
      {runKind === "command" ? (
        <>
          <label>Command</label>
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 8 }}
            value={value.command ?? ""}
            disabled={disabled}
            placeholder="What bash command should run on each scheduled run?"
            onChange={(e) => onChange({ command: e.target.value })}
          />
          <label>Working directory</label>
          <Input
            value={value.command_cwd ?? ""}
            disabled={disabled}
            placeholder="Defaults to the chat directory"
            onChange={(e) => onChange({ command_cwd: e.target.value })}
          />
          <label>Timeout (seconds)</label>
          <InputNumber
            min={1}
            max={24 * 60 * 60}
            disabled={disabled}
            style={{ width: "100%" }}
            value={inputNumberValue({
              draft,
              key: "command_timeout_ms",
              fallback: DEFAULT_COMMAND_TIMEOUT_MS,
              scale: 1000,
            })}
            onChange={(next) =>
              onChange({
                command_timeout_ms:
                  next == null
                    ? clearedNumber()
                    : Math.max(1, Number(next)) * 1000,
              })
            }
          />
          <label>Max output to capture (KB)</label>
          <InputNumber
            min={1}
            max={10 * 1024}
            disabled={disabled}
            style={{ width: "100%" }}
            value={inputNumberValue({
              draft,
              key: "command_max_output_bytes",
              fallback: DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
              scale: 1000,
            })}
            onChange={(next) =>
              onChange({
                command_max_output_bytes:
                  next == null
                    ? clearedNumber()
                    : Math.max(1, Number(next)) * 1000,
              })
            }
          />
        </>
      ) : (
        <>
          <label>Prompt</label>
          <Input.TextArea
            autoSize={{ minRows: 4, maxRows: 10 }}
            value={value.prompt ?? ""}
            disabled={disabled}
            placeholder={promptPlaceholder}
            onChange={(e) => onChange({ prompt: e.target.value })}
          />
        </>
      )}
      <label>Schedule</label>
      <Select
        value={scheduleType}
        disabled={disabled}
        options={[
          { label: "Daily", value: "daily" },
          { label: "Every N minutes", value: "interval" },
        ]}
        onChange={(next) =>
          onChange({
            schedule_type: next === "interval" ? "interval" : "daily",
          })
        }
      />
      <label>Repeat on</label>
      <Space size={8} wrap>
        {ALL_DAYS.map((day, index) => {
          const isSelected = selectedDays.includes(day);
          return (
            <Tooltip key={day} title={DAY_LONG_LABELS[index]}>
              <Button
                shape="circle"
                type={isSelected ? "primary" : "default"}
                disabled={disabled}
                onClick={() => {
                  if (isSelected && selectedDays.length === 1) {
                    return;
                  }
                  onChange({
                    days_of_week: isSelected
                      ? selectedDays.filter((value) => value !== day)
                      : [...selectedDays, day].sort(
                          (left, right) => left - right,
                        ),
                  });
                }}
              >
                {DAY_SHORT_LABELS[index]}
              </Button>
            </Tooltip>
          );
        })}
      </Space>
      {scheduleType === "interval" ? (
        <>
          <label>Repeat every (minutes)</label>
          <InputNumber
            min={5}
            max={24 * 60}
            disabled={disabled}
            style={{ width: "100%" }}
            value={inputNumberValue({
              draft,
              key: "interval_minutes",
              fallback: DEFAULT_INTERVAL_MINUTES,
            })}
            onChange={(next) =>
              onChange({
                interval_minutes: next == null ? clearedNumber() : Number(next),
              })
            }
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Switch
              checked={isAllDayWindow(value)}
              disabled={disabled}
              onChange={(checked) =>
                onChange({
                  window_start_local_time: checked
                    ? DEFAULT_WINDOW_START_LOCAL_TIME
                    : DEFAULT_RANGE_START_LOCAL_TIME,
                  window_end_local_time: checked
                    ? DEFAULT_WINDOW_END_LOCAL_TIME
                    : DEFAULT_RANGE_END_LOCAL_TIME,
                })
              }
            />
            <span>Run all day</span>
          </div>
          {!isAllDayWindow(value) ? (
            <>
              <label>From (24h)</label>
              <Input
                value={
                  value.window_start_local_time ??
                  DEFAULT_RANGE_START_LOCAL_TIME
                }
                disabled={disabled}
                placeholder={DEFAULT_RANGE_START_LOCAL_TIME}
                onChange={(e) =>
                  onChange({ window_start_local_time: e.target.value })
                }
              />
              <label>Until (24h)</label>
              <Input
                value={
                  value.window_end_local_time ?? DEFAULT_RANGE_END_LOCAL_TIME
                }
                disabled={disabled}
                placeholder={DEFAULT_RANGE_END_LOCAL_TIME}
                onChange={(e) =>
                  onChange({ window_end_local_time: e.target.value })
                }
              />
            </>
          ) : null}
        </>
      ) : (
        <>
          <label>Run at (24h)</label>
          <Input
            value={value.local_time ?? DEFAULT_LOCAL_TIME}
            disabled={disabled}
            placeholder={DEFAULT_LOCAL_TIME}
            onChange={(e) => onChange({ local_time: e.target.value })}
          />
        </>
      )}
      <label>Timezone</label>
      <Input
        value={value.timezone ?? resolvedTimezone()}
        disabled={disabled}
        placeholder="America/Los_Angeles"
        onChange={(e) => onChange({ timezone: e.target.value })}
      />
      <label>Pause after unacknowledged runs</label>
      <InputNumber
        min={1}
        max={365}
        disabled={disabled}
        style={{ width: "100%" }}
        value={inputNumberValue({
          draft,
          key: "pause_after_unacknowledged_runs",
          fallback: DEFAULT_PAUSE_AFTER_RUNS,
        })}
        onChange={(next) =>
          onChange({
            pause_after_unacknowledged_runs:
              next == null ? clearedNumber() : Number(next),
          })
        }
      />
    </div>
  );
}
