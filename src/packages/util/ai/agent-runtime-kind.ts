/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Which runtime an agent uses, as a server-side fact about the agent (kept
// on its identity record), so lists can show it without loading the chat.

import { isCodexModelName } from "./codex";

export type AgentRuntimeKind = "codex" | "claude-code" | "acp";

export interface AgentRuntimeSummary {
  kind: AgentRuntimeKind;
  /** Harness id for generic ACP agents. */
  name?: string;
  /** The model its runtime last said it uses, as the runtime names it
   * (`gpt-6-luna`, or Claude Code's alias `opus`). */
  model?: string;
  /** The runtime's own display name for that model (`Opus 5.5`), if any. */
  model_name?: string;
  /** Reasoning effort (thinking level): `low`, `medium`, `high`, ... */
  effort?: string;
}

const MODEL_TEXT_MAX = 100;

/** A bounded one-line label, or undefined. */
function modelText(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return text ? text.slice(0, MODEL_TEXT_MAX) : undefined;
}

/** The model fields of a summary that has them. */
function modelFields(value: {
  model?: unknown;
  model_name?: unknown;
  effort?: unknown;
}): Pick<AgentRuntimeSummary, "model" | "model_name" | "effort"> {
  const model = modelText(value.model);
  // A display name without the model it names says nothing reliable.
  const model_name = model ? modelText(value.model_name) : undefined;
  const effort = modelText(value.effort);
  return {
    ...(model ? { model } : {}),
    ...(model_name && model_name !== model ? { model_name } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function parseAgentRuntimeSummary(
  value: unknown,
): AgentRuntimeSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const obj = value as Record<string, unknown>;
  if (obj.kind === "codex" || obj.kind === "claude-code")
    return { kind: obj.kind, ...modelFields(obj) };
  if (obj.kind === "acp") {
    const name =
      typeof obj.name === "string" && obj.name.trim()
        ? obj.name.trim().slice(0, 100)
        : undefined;
    return { kind: "acp", ...(name ? { name } : {}), ...modelFields(obj) };
  }
}

/**
 * The model and effort from an ACP harness's session controls (what the
 * harness itself says is selected now, with its display names), falling
 * back to the saved settings (values only).
 */
export function agentModelFromHarness(opts: {
  controls?: unknown;
  settings?: unknown;
}): Pick<AgentRuntimeSummary, "model" | "model_name" | "effort"> {
  const options = (value: unknown): any[] => {
    const list = (value as any)?.configOptions;
    return Array.isArray(list) ? list.slice(0, 32) : [];
  };
  const control = (id: string) =>
    options(opts.controls).find((option) => option?.id === id);
  const saved = (id: string) =>
    options(opts.settings).find((option) => option?.id === id)?.value;
  const nameOf = (id: string) => {
    const c = control(id);
    const value = c?.currentValue;
    if (typeof value !== "string" || !Array.isArray(c?.options)) return;
    return c.options.find((option: any) => option?.value === value)?.name;
  };
  const model = control("model")?.currentValue ?? saved("model");
  const effort = control("effort")?.currentValue ?? saved("effort");
  return modelFields({
    model: model === "default" ? undefined : model,
    model_name: control("model") ? nameOf("model") : undefined,
    effort: effort === "default" ? undefined : effort,
  });
}

/** The model and effort a native Codex configuration names. */
export function agentModelFromCodex(config: {
  model?: unknown;
  reasoning?: unknown;
}): Pick<AgentRuntimeSummary, "model" | "model_name" | "effort"> {
  return modelFields({ model: config.model, effort: config.reasoning });
}

export function agentRuntimeFromProfile(
  profile: { version: number; id: string } | undefined,
): AgentRuntimeSummary {
  if (!profile) return { kind: "codex" };
  if (profile.version === 2 && profile.id === "claude-code")
    return { kind: "claude-code" };
  return {
    kind: "acp",
    name: `${profile.id ?? ""}`.slice(0, 100) || undefined,
  };
}

/**
 * From a chat thread's configuration; undefined if it is not an agent. A
 * thread that runs an ACP harness (Claude Code) may still carry Codex model
 * fields (`agent_model`, `acp_config.model`) from before it switched: those
 * never describe it.
 */
export function agentRuntimeFromThread(thread: {
  agent_runtime?: {
    profile?: { version: number; id: string };
    settings?: unknown;
  } | null;
  agent_runtime_controls?: unknown;
  agent_kind?: string | null;
  agent_model?: string | null;
  acp_config?: unknown;
}): AgentRuntimeSummary | undefined {
  const profile = thread.agent_runtime?.profile;
  if (profile) {
    const controls = thread.agent_runtime_controls as any;
    // Controls reported by another harness (before a switch) don't apply.
    const sameHarness =
      controls?.profile?.id === profile.id &&
      controls?.profile?.version === profile.version;
    return {
      ...agentRuntimeFromProfile(profile),
      ...agentModelFromHarness({
        controls: sameHarness ? controls?.controls : undefined,
        settings: thread.agent_runtime?.settings,
      }),
    };
  }
  if (
    thread.agent_kind === "acp" ||
    thread.acp_config != null ||
    isCodexModelName(thread.agent_model ?? undefined)
  ) {
    const config = (thread.acp_config ?? {}) as {
      model?: unknown;
      reasoning?: unknown;
    };
    return {
      kind: "codex",
      ...agentModelFromCodex({
        model: config.model ?? thread.agent_model,
        reasoning: config.reasoning,
      }),
    };
  }
}

export function sameAgentRuntime(
  a: AgentRuntimeSummary | null | undefined,
  b: AgentRuntimeSummary | null | undefined,
): boolean {
  return (
    (a?.kind ?? null) === (b?.kind ?? null) &&
    a?.name === b?.name &&
    a?.model === b?.model &&
    a?.model_name === b?.model_name &&
    a?.effort === b?.effort
  );
}

/**
 * What to store when a host reports `next`: a report that names no model
 * (an older host, or one sent before the runtime said) keeps the model
 * already known for the same runtime, rather than erasing it.
 */
export function mergeAgentRuntime(
  previous: AgentRuntimeSummary | null | undefined,
  next: AgentRuntimeSummary,
): AgentRuntimeSummary {
  if (
    next.model ||
    !previous?.model ||
    previous.kind !== next.kind ||
    previous.name !== next.name
  )
    return next;
  return { ...modelFields(previous), ...next } as AgentRuntimeSummary;
}

/** The model as people and agents read it: `Opus 5.5 (opus)`, `gpt-6-luna`. */
export function agentModelLabel(
  runtime: AgentRuntimeSummary | null | undefined,
): string | undefined {
  if (!runtime?.model) return;
  return runtime.model_name && runtime.model_name !== runtime.model
    ? `${runtime.model_name} (${runtime.model})`
    : runtime.model;
}

export function agentRuntimeLabel(runtime: AgentRuntimeSummary): string {
  if (runtime.kind === "codex") return "Codex";
  if (runtime.kind === "claude-code") return "Claude Code";
  return runtime.name ? `ACP: ${runtime.name}` : "ACP";
}
