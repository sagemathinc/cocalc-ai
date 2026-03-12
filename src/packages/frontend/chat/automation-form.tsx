/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Input, InputNumber, Switch } from "antd";
import type { AcpAutomationConfig } from "@cocalc/conat/ai/acp/types";

const DEFAULT_LOCAL_TIME = "05:00";
const DEFAULT_PAUSE_AFTER_RUNS = 7;

function resolvedTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
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
    local_time: DEFAULT_LOCAL_TIME,
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
  const local_time = `${draft.local_time ?? ""}`.trim();
  const timezone = `${draft.timezone ?? ""}`.trim() || resolvedTimezone();
  if (!prompt || !local_time || !timezone) {
    return undefined;
  }
  return {
    enabled: draft.enabled !== false,
    automation_id: automationId,
    title: `${draft.title ?? ""}`.trim() || undefined,
    prompt,
    schedule_type: "daily",
    local_time,
    timezone,
    pause_after_unacknowledged_runs: Number(
      draft.pause_after_unacknowledged_runs ?? DEFAULT_PAUSE_AFTER_RUNS,
    ),
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
      <label>Run daily at (24h)</label>
      <Input
        value={value.local_time ?? DEFAULT_LOCAL_TIME}
        disabled={disabled}
        placeholder={DEFAULT_LOCAL_TIME}
        onChange={(e) => onChange({ local_time: e.target.value })}
      />
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
