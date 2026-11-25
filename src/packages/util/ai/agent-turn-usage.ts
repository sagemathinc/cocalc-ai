/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// What one agent turn used, as its runtime reported it: tokens by model, for
// Claude and Codex alike, with the conversation and the credential that paid.
// Stored per account (its home bay) to show usage by agent. Tokens are exact
// and local to this site; a subscription shared with another site also has
// usage this site never sees.

import { isValidUUID } from "../misc";

export type AgentTurnUsageProvider = "claude" | "codex";
export type AgentTurnUsageOutcome = "completed" | "failed" | "interrupted";

export interface AgentTurnModelUsage {
  model: string;
  /** Uncached input (Anthropic's input_tokens; Codex input minus cached). */
  input_tokens: number;
  /** Cache reads. */
  cached_input_tokens: number;
  /** Cache writes (Claude only). */
  cache_write_tokens: number;
  /** Output, reasoning included. */
  output_tokens: number;
  /** The part of the output that was reasoning, when reported (Codex). */
  reasoning_output_tokens: number;
}

export interface AgentTurnUsage {
  /** Stable identity of the turn's report: a resent report is stored once. */
  turn_id?: string;
  project_id: string;
  path: string;
  thread_id: string;
  provider: AgentTurnUsageProvider;
  /** How the turn was paid: a Claude credential mode or a Codex auth source. */
  payment: string;
  credential_id?: string;
  /** Claude Auto picked the subscription. */
  pool?: boolean;
  models: AgentTurnModelUsage[];
  started_at: number;
  ended_at: number;
  outcome: AgentTurnUsageOutcome;
}

/** Stored turns are deleted this long after the home bay received them. */
export const AGENT_TURN_USAGE_RETENTION_DAYS = 90;

export const MAX_TURN_USAGE_MODELS = 8;
/** A report is refused if its turn ended more than this far in the future
 * (clock skew allowance) ... */
export const TURN_USAGE_MAX_FUTURE_MS = 10 * 60_000;
/** ... or started more than this long ago (late reports, long goals) ... */
export const TURN_USAGE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** ... or ran longer than this. */
export const TURN_USAGE_MAX_DURATION_MS = 7 * 24 * 60 * 60_000;
const MAX_TOKENS = 1e12;

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_TOKENS, Math.floor(n));
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\x00-\x1f]/.test(trimmed))
    return undefined;
  return trimmed;
}

export function totalTurnTokens(usage: Pick<AgentTurnUsage, "models">): number {
  let total = 0;
  for (const m of usage.models)
    total +=
      m.input_tokens +
      m.cached_input_tokens +
      m.cache_write_tokens +
      m.output_tokens;
  return total;
}

/** Revalidate a reported turn: undefined if it is not usable. Never trusts
 * what a host sent beyond these fields and bounds. */
export function parseAgentTurnUsage(
  value: unknown,
  now = Date.now(),
): AgentTurnUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const v = value as Record<string, unknown>;
  const project_id = text(v.project_id, 64);
  const path = text(v.path, 4096);
  const thread_id = text(v.thread_id, 256);
  const payment = text(v.payment, 64);
  if (
    !project_id ||
    !isValidUUID(project_id) ||
    !path ||
    !thread_id ||
    !payment ||
    (v.provider !== "claude" && v.provider !== "codex") ||
    (v.outcome !== "completed" &&
      v.outcome !== "failed" &&
      v.outcome !== "interrupted")
  )
    return undefined;
  const turn_id = v.turn_id == null ? undefined : text(v.turn_id, 64);
  if (v.turn_id != null && (!turn_id || !isValidUUID(turn_id)))
    return undefined;
  const credential_id =
    v.credential_id == null ? undefined : text(v.credential_id, 64);
  if (
    v.credential_id != null &&
    (!credential_id || !isValidUUID(credential_id))
  )
    return undefined;
  const started_at = Number(v.started_at);
  const ended_at = Number(v.ended_at);
  // Bounded around the checker's clock: a host cannot store a turn dated far
  // in the future (it would never age out) or outside the database's range.
  if (
    !Number.isFinite(started_at) ||
    !Number.isFinite(ended_at) ||
    ended_at < started_at ||
    ended_at > now + TURN_USAGE_MAX_FUTURE_MS ||
    started_at < now - TURN_USAGE_MAX_AGE_MS ||
    ended_at - started_at > TURN_USAGE_MAX_DURATION_MS
  )
    return undefined;
  if (!Array.isArray(v.models)) return undefined;
  const models: AgentTurnModelUsage[] = [];
  for (const raw of v.models.slice(0, MAX_TURN_USAGE_MODELS)) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const model = text(m.model, 128) ?? "unknown";
    const entry = {
      model,
      input_tokens: count(m.input_tokens),
      cached_input_tokens: count(m.cached_input_tokens),
      cache_write_tokens: count(m.cache_write_tokens),
      output_tokens: count(m.output_tokens),
      reasoning_output_tokens: count(m.reasoning_output_tokens),
    };
    if (
      entry.input_tokens +
        entry.cached_input_tokens +
        entry.cache_write_tokens +
        entry.output_tokens >
      0
    )
      models.push(entry);
  }
  if (!models.length) return undefined;
  return {
    ...(turn_id ? { turn_id } : {}),
    project_id,
    path,
    thread_id,
    provider: v.provider,
    payment,
    ...(credential_id ? { credential_id } : {}),
    ...(v.pool === true ? { pool: true } : {}),
    models,
    started_at,
    ended_at,
    outcome: v.outcome,
  };
}

/**
 * Claude's prompt response: `_meta.quota.model_usage` (per model, this turn)
 * from claude-agent-acp, else its `usage` totals under one unknown model.
 */
export function claudeTurnModelUsage(response: unknown): AgentTurnModelUsage[] {
  const r = (response ?? {}) as Record<string, any>;
  const fromCount = (model: string, c: Record<string, unknown> | undefined) =>
    c
      ? {
          model,
          input_tokens: count(c.inputTokens),
          cached_input_tokens: count(c.cachedInputTokens ?? c.cachedReadTokens),
          cache_write_tokens: count(c.cachedWriteTokens),
          output_tokens: count(c.outputTokens),
          reasoning_output_tokens: count(c.reasoningOutputTokens),
        }
      : undefined;
  const perModel = r?._meta?.quota?.model_usage;
  const out: AgentTurnModelUsage[] = [];
  if (Array.isArray(perModel)) {
    for (const entry of perModel) {
      const m = fromCount(
        text(entry?.model, 128) ?? "unknown",
        entry?.token_count,
      );
      if (m) out.push(m);
    }
  }
  if (!out.length) {
    const m = fromCount("unknown", r?.usage);
    if (m) out.push(m);
  }
  return out.filter(
    (m) =>
      m.input_tokens +
        m.cached_input_tokens +
        m.cache_write_tokens +
        m.output_tokens >
      0,
  );
}

/** Codex thread token totals ({input, cachedInput, output, reasoningOutput}). */
export type CodexTokenTotals = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
};

/**
 * One Codex turn's tokens: the thread's running total at the turn's last
 * report minus its total before the turn (the first report's total less that
 * report's own request). Codex counts cached input inside input.
 */
export function codexTurnModelUsage(
  model: string | undefined,
  first: { total?: CodexTokenTotals; last?: CodexTokenTotals } | undefined,
  latest: { total?: CodexTokenTotals } | undefined,
): AgentTurnModelUsage[] {
  if (!first?.total || !latest?.total) return [];
  const before = (key: keyof CodexTokenTotals) =>
    count(first.total?.[key]) - count(first.last?.[key]);
  const used = (key: keyof CodexTokenTotals) =>
    Math.max(0, count(latest.total?.[key]) - Math.max(0, before(key)));
  const input = used("inputTokens");
  const cached = Math.min(input, used("cachedInputTokens"));
  const entry: AgentTurnModelUsage = {
    model: text(model, 128) ?? "unknown",
    input_tokens: input - cached,
    cached_input_tokens: cached,
    cache_write_tokens: 0,
    output_tokens: used("outputTokens"),
    reasoning_output_tokens: used("reasoningOutputTokens"),
  };
  return entry.input_tokens + entry.cached_input_tokens + entry.output_tokens >
    0
    ? [entry]
    : [];
}

/** Sum entries for the same model (a turn's threads, say). */
export function mergeTurnModelUsage(
  entries: readonly AgentTurnModelUsage[],
): AgentTurnModelUsage[] {
  const byModel = new Map<string, AgentTurnModelUsage>();
  for (const e of entries) {
    const m = byModel.get(e.model);
    if (!m) {
      byModel.set(e.model, { ...e });
      continue;
    }
    m.input_tokens += e.input_tokens;
    m.cached_input_tokens += e.cached_input_tokens;
    m.cache_write_tokens += e.cache_write_tokens;
    m.output_tokens += e.output_tokens;
    m.reasoning_output_tokens += e.reasoning_output_tokens;
  }
  return [...byModel.values()].slice(0, MAX_TURN_USAGE_MODELS);
}

/** One agent conversation's use of one model over a period (usage by agent). */
export interface AgentUsageRow {
  project_id: string;
  /** With project_id and thread_id, which agent: a hash of its chat path. */
  path_hash: string;
  thread_id: string;
  provider: AgentTurnUsageProvider;
  model: string;
  /** The account's name for the agent, when this is its current conversation. */
  name?: string;
  turns: number;
  /** Each token sum is at most Number.MAX_SAFE_INTEGER (capped). */
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  /** When the last of these turns ended (ISO). */
  last_at: string;
}

export interface AgentUsageReport {
  /** The period: turns that ended since then (ISO). */
  since: string;
  hours: number;
  rows: AgentUsageRow[];
  /** More rows than returned (the busiest are kept). */
  truncated?: boolean;
}

/** Periods the report offers (hours): at most the retention. */
export const AGENT_USAGE_REPORT_MAX_HOURS =
  AGENT_TURN_USAGE_RETENTION_DAYS * 24;
export const AGENT_USAGE_REPORT_MAX_ROWS = 500;
