/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Button,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tooltip,
} from "antd";
import type { AcpAutomationConfig } from "@cocalc/conat/ai/acp/types";

const DEFAULT_LOCAL_TIME = "05:00";
const DEFAULT_INTERVAL_MINUTES = 120;
const DEFAULT_WINDOW_START_LOCAL_TIME = "06:00";
const DEFAULT_WINDOW_END_LOCAL_TIME = "20:00";
const DEFAULT_PAUSE_AFTER_RUNS = 7;

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

export function hasAutomationConfigContent(
  config?: AcpAutomationConfig,
): boolean {
  return !!(
    config &&
    (config.automation_id ||
      config.prompt ||
      config.title ||
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
}: {
  enabled?: boolean;
  prompt?: string;
} = {}): AcpAutomationConfig {
  return {
    enabled,
    schedule_type: "daily",
    days_of_week: [...ALL_DAYS],
    local_time: DEFAULT_LOCAL_TIME,
    interval_minutes: DEFAULT_INTERVAL_MINUTES,
    window_start_local_time: DEFAULT_WINDOW_START_LOCAL_TIME,
    window_end_local_time: DEFAULT_WINDOW_END_LOCAL_TIME,
    timezone: resolvedTimezone(),
    pause_after_unacknowledged_runs: DEFAULT_PAUSE_AFTER_RUNS,
    prompt,
  };
}

export function buildAutomationDraft({
  config,
  enabled = true,
  promptFallback,
}: {
  config?: AcpAutomationConfig;
  enabled?: boolean;
  promptFallback?: string;
} = {}): AcpAutomationConfig {
  const base = getDefaultAutomationConfig({
    enabled,
    prompt: promptFallback,
  });
  return {
    ...base,
    ...(config ?? {}),
    days_of_week: normalizeDaysOfWeek(config?.days_of_week),
  };
}

export function normalizeAutomationConfigForSave({
  draft,
  automationId,
}: {
  draft?: AcpAutomationConfig;
  automationId?: string;
}): AcpAutomationConfig | undefined {
  if (!draft) return undefined;
  const prompt = `${draft.prompt ?? ""}`.trim();
  const timezone = `${draft.timezone ?? ""}`.trim() || resolvedTimezone();
  const days_of_week = normalizeDaysOfWeek(draft.days_of_week);
  const pause_after_unacknowledged_runs = Number(
    draft.pause_after_unacknowledged_runs ?? DEFAULT_PAUSE_AFTER_RUNS,
  );
  const schedule_type =
    draft.schedule_type === "interval" ? "interval" : "daily";
  if (!prompt || !timezone) {
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
      prompt,
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
    prompt,
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

interface AutomationConfigFieldsProps {
  draft?: AcpAutomationConfig;
  onChange: (patch: Partial<AcpAutomationConfig>) => void;
  disabled?: boolean;
  showEnableToggle?: boolean;
  enableLabel?: string;
  titlePlaceholder?: string;
  promptPlaceholder?: string;
}

export function AutomationConfigFields({
  draft,
  onChange,
  disabled = false,
  showEnableToggle = true,
  enableLabel = "Enable scheduled automation for this thread",
  titlePlaceholder = "Daily project status",
  promptPlaceholder = "What should Codex do on each scheduled run?",
}: AutomationConfigFieldsProps) {
  const value = buildAutomationDraft({ config: draft });
  const selectedDays = normalizeDaysOfWeek(value.days_of_week);
  const scheduleType =
    value.schedule_type === "interval" ? "interval" : "daily";

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
      <label>Prompt</label>
      <Input.TextArea
        autoSize={{ minRows: 4, maxRows: 10 }}
        value={value.prompt ?? ""}
        disabled={disabled}
        placeholder={promptPlaceholder}
        onChange={(e) => onChange({ prompt: e.target.value })}
      />
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
            value={value.interval_minutes ?? DEFAULT_INTERVAL_MINUTES}
            onChange={(next) =>
              onChange({
                interval_minutes: Number(next ?? DEFAULT_INTERVAL_MINUTES),
              })
            }
          />
          <label>From (24h)</label>
          <Input
            value={
              value.window_start_local_time ?? DEFAULT_WINDOW_START_LOCAL_TIME
            }
            disabled={disabled}
            placeholder={DEFAULT_WINDOW_START_LOCAL_TIME}
            onChange={(e) =>
              onChange({ window_start_local_time: e.target.value })
            }
          />
          <label>Until (24h)</label>
          <Input
            value={value.window_end_local_time ?? DEFAULT_WINDOW_END_LOCAL_TIME}
            disabled={disabled}
            placeholder={DEFAULT_WINDOW_END_LOCAL_TIME}
            onChange={(e) =>
              onChange({ window_end_local_time: e.target.value })
            }
          />
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
        value={
          value.pause_after_unacknowledged_runs ?? DEFAULT_PAUSE_AFTER_RUNS
        }
        onChange={(next) =>
          onChange({
            pause_after_unacknowledged_runs: Number(
              next ?? DEFAULT_PAUSE_AFTER_RUNS,
            ),
          })
        }
      />
    </div>
  );
}
