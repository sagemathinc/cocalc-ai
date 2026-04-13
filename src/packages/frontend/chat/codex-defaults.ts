/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { set_account_table } from "@cocalc/frontend/account/util";
import { redux } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";
import {
  DEFAULT_CODEX_MODEL_NAME,
  DEFAULT_CODEX_MODELS,
  type CodexReasoningId,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";

export const OTHER_SETTINGS_CODEX_NEW_CHAT_DEFAULTS = "codex_new_chat_defaults";

export const ALL_CODEX_NEW_CHAT_MODE_OPTIONS: {
  value: CodexSessionMode;
  label: string;
}[] = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "full-access", label: "Full access" },
];

function isLaunchpadCodexRuntime(): boolean {
  if (lite) return false;
  const customizeStore = redux?.getStore?.("customize");
  return customizeStore?.get?.("is_launchpad") === true;
}

export function getCodexNewChatModeOptions(): {
  value: CodexSessionMode;
  label: string;
}[] {
  if (isLaunchpadCodexRuntime()) {
    return ALL_CODEX_NEW_CHAT_MODE_OPTIONS.filter(
      ({ value }) => value !== "workspace-write",
    );
  }
  return ALL_CODEX_NEW_CHAT_MODE_OPTIONS;
}

export interface CodexNewChatDefaults {
  model: string;
  reasoning?: CodexReasoningId;
  sessionMode: CodexSessionMode;
}

export function getDefaultCodexSessionMode(): CodexSessionMode {
  if (lite) return "workspace-write";
  if (isLaunchpadCodexRuntime()) return "full-access";
  return "workspace-write";
}

export function normalizeCodexNewChatDefaults(
  value?: Partial<CodexNewChatDefaults> | null,
): CodexNewChatDefaults {
  const model = normalizeCodexModelName(value?.model);
  const sessionMode = normalizeCodexSessionModeValue(value?.sessionMode);
  return {
    model,
    sessionMode,
    reasoning: normalizeCodexReasoning(model, value?.reasoning),
  };
}

export function getStoredCodexNewChatDefaults(
  raw?: unknown,
): CodexNewChatDefaults | undefined {
  const value = toPlainObject(
    raw ??
      redux
        ?.getStore?.("account")
        ?.getIn?.(["other_settings", OTHER_SETTINGS_CODEX_NEW_CHAT_DEFAULTS]),
  ) as Partial<CodexNewChatDefaults> | undefined;
  if (value == null || typeof value !== "object") return undefined;
  return normalizeCodexNewChatDefaults(value);
}

export function getDefaultCodexNewChatDefaults(): CodexNewChatDefaults {
  return normalizeCodexNewChatDefaults(getStoredCodexNewChatDefaults());
}

export function saveCodexNewChatDefaults(
  value: Partial<CodexNewChatDefaults>,
): CodexNewChatDefaults {
  const normalized = normalizeCodexNewChatDefaults(value);
  set_account_table({
    other_settings: {
      [OTHER_SETTINGS_CODEX_NEW_CHAT_DEFAULTS]: normalized,
    },
  });
  return normalized;
}

export function codexNewChatDefaultsEqual(
  left?: Partial<CodexNewChatDefaults> | null,
  right?: Partial<CodexNewChatDefaults> | null,
): boolean {
  const a = normalizeCodexNewChatDefaults(left);
  const b = normalizeCodexNewChatDefaults(right);
  return (
    a.model === b.model &&
    a.reasoning === b.reasoning &&
    a.sessionMode === b.sessionMode
  );
}

function normalizeCodexModelName(model?: string): string {
  const value = `${model ?? ""}`.trim();
  if (DEFAULT_CODEX_MODELS.some((entry) => entry.name === value)) return value;
  return DEFAULT_CODEX_MODELS[0]?.name ?? DEFAULT_CODEX_MODEL_NAME;
}

function normalizeCodexSessionModeValue(mode?: string): CodexSessionMode {
  if (
    mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "full-access"
  ) {
    if (isLaunchpadCodexRuntime() && mode === "workspace-write") {
      return "full-access";
    }
    return mode;
  }
  return getDefaultCodexSessionMode();
}

function normalizeCodexReasoning(
  model: string,
  desired?: CodexReasoningId,
): CodexReasoningId | undefined {
  const options =
    DEFAULT_CODEX_MODELS.find((entry) => entry.name === model)?.reasoning ?? [];
  if (!options.length) return undefined;
  const exact = options.find((option) => option.id === desired);
  return (
    exact?.id ?? options.find((option) => option.default)?.id ?? options[0]?.id
  );
}

function toPlainObject(value: unknown): unknown {
  if (value != null && typeof value === "object") {
    const candidate = value as { toJS?: () => unknown };
    if (typeof candidate.toJS === "function") return candidate.toJS();
  }
  return value;
}
