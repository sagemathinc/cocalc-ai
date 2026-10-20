/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// How an agent turn ended, as data. It is classified once, on the host that
// ran the turn, from the most specific signal available: a provider's own
// limit event, a recovery code, CoCalc's own lifecycle, and only then the
// error text. Everything else (delivery reports, notices, recovery, agent
// status) reads this instead of parsing error strings.

export type TurnFailure =
  | {
      kind: "limit";
      /** Whose limit: the account's own subscription or key, or CoCalc's. */
      scope: "credential" | "cocalc";
      credential_id?: string;
      /** When it resets (ms), if the provider said. */
      resets_at?: number;
      /** e.g. "five_hour" or "seven_day" for Claude. */
      window?: string;
    }
  | { kind: "sign-in"; credential_id?: string }
  /** The model's own safety check. */
  | { kind: "refused" }
  /** The agent's runtime or host went away during the turn. */
  | { kind: "host-lost" }
  | { kind: "project-stopped" }
  | { kind: "timeout" }
  /** `code` is an ACP or recovery code, never text. */
  | { kind: "error"; code?: string };

export type TurnFailureKind = TurnFailure["kind"];

export type TurnOutcome = {
  version: 1;
  /** One short line for people. Code reads the typed fields only. */
  detail?: string;
  /** How the failure was classified; "text" means only by its message. */
  classified_by?: "signal" | "text";
} & (
  | { state: "completed" }
  | {
      state: "failed";
      failure: TurnFailure;
      /** Any tool ran before it ended, so it may have changed something.
       * Absent when it is not known. */
      tool_ran?: boolean;
    }
  | {
      state: "canceled";
      /** person: someone in the recipient's project stopped or canceled it. */
      by: "person" | "sender" | "superseded" | "system";
      tool_ran?: boolean;
    }
  | {
      state: "never-started";
      reason: "project-stopped" | "host-lost" | "expired" | "canceled";
    }
);

export const TURN_OUTCOME_DETAIL_MAX = 300;

const FAILURE_KINDS: TurnFailureKind[] = [
  "limit",
  "sign-in",
  "refused",
  "host-lost",
  "project-stopped",
  "timeout",
  "error",
];

/** One short line, so a long error cannot flood whoever reads it. */
export function turnOutcomeDetail(text: unknown): string | undefined {
  const line = `${text ?? ""}`.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > TURN_OUTCOME_DETAIL_MAX
    ? `${line.slice(0, TURN_OUTCOME_DETAIL_MAX - 1)}…`
    : line;
}

const YEAR_MS = 366 * 24 * 60 * 60 * 1000;

function resetTime(value: unknown, now: number): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Claude reports seconds; accept milliseconds too.
  const ms = n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  return Math.abs(ms - now) <= YEAR_MS ? ms : undefined;
}

function shortToken(value: unknown): string | undefined {
  const text = `${value ?? ""}`.trim();
  return /^[a-z0-9_-]{1,40}$/i.test(text) ? text : undefined;
}

/**
 * Claude's rate_limit_info, as the harness forwards it with each response.
 * Only a rejection is a failure; "allowed_warning" is not.
 */
export function turnFailureFromRateLimit(
  info: unknown,
  credential_id?: string,
  now = Date.now(),
): TurnFailure | undefined {
  if (!info || typeof info !== "object") return undefined;
  const data = info as Record<string, unknown>;
  if (data.status !== "rejected") return undefined;
  const resets_at = resetTime(data.resetsAt, now);
  const window = shortToken(data.rateLimitType);
  return {
    kind: "limit",
    scope: "credential",
    ...(credential_id ? { credential_id } : {}),
    ...(resets_at ? { resets_at } : {}),
    ...(window ? { window } : {}),
  };
}

// Recovery codes (ai/acp/codex-app-server.ts CODEX_ACP_RECOVERY_ERROR_CODE)
// that say what happened. The others stay error{code}.
const HOST_LOST_CODES = new Set([
  "codex_turn_lost",
  "codex_app_server_exited",
  "acp_harness_killed",
]);

export function turnFailureFromCode(
  code: string | undefined,
): TurnFailure | undefined {
  const value = shortToken(code);
  if (!value) return undefined;
  if (HOST_LOST_CODES.has(value)) return { kind: "host-lost" };
  return { kind: "error", code: value };
}

/** The last resort: sort an error message by what it says. */
export function turnFailureFromText(text: string): TurnFailure {
  const t = `${text ?? ""}`.toLowerCase();
  if (
    /flagged|cybersecurity|safety|refus|policy violation|content policy|not allowed to/.test(
      t,
    )
  )
    return { kind: "refused" };
  if (
    /usage limit|rate limit|quota|credit|insufficient|billing|subscription|payment|out of (?:funds|tokens)|limit reached|hit your (?:\S+ )?limit|(?:weekly|session|5-hour|five-hour) limit|429/.test(
      t,
    )
  )
    return {
      kind: "limit",
      scope: /membership|cocalc ai usage|site-provided/.test(t)
        ? "cocalc"
        : "credential",
    };
  if (
    /sign[- ]?in|signed out|not signed in|log ?in|unauthori[sz]ed|authenticat|expired token|token expired|api key|401|403/.test(
      t,
    )
  )
    return { kind: "sign-in" };
  if (/timed? ?out|timeout|deadline exceeded/.test(t))
    return { kind: "timeout" };
  return { kind: "error" };
}

/**
 * The outcome of a turn the host ran, from its terminal state and the best
 * signal it saw: an explicit failure first, then a recovery code, then text.
 */
export function turnOutcomeOf(opts: {
  terminalState: "completed" | "error" | "interrupted";
  failure?: TurnFailure;
  code?: string;
  error?: string;
  /** Undefined when it is not known. */
  toolRan?: boolean;
}): TurnOutcome {
  if (opts.terminalState === "completed")
    return { version: 1, state: "completed" };
  const detail = turnOutcomeDetail(opts.error);
  if (opts.terminalState === "interrupted")
    return {
      version: 1,
      state: "canceled",
      by: "person",
      ...(opts.toolRan !== undefined ? { tool_ran: opts.toolRan } : {}),
      ...(detail ? { detail } : {}),
    };
  const signal = opts.failure ?? turnFailureFromCode(opts.code);
  return {
    version: 1,
    state: "failed",
    failure: signal ?? turnFailureFromText(opts.error ?? ""),
    ...(opts.toolRan !== undefined ? { tool_ran: opts.toolRan } : {}),
    classified_by: signal ? "signal" : "text",
    ...(detail ? { detail } : {}),
  };
}

function validFailure(value: unknown): value is TurnFailure {
  if (!value || typeof value !== "object") return false;
  const failure = value as Record<string, unknown>;
  if (!FAILURE_KINDS.includes(failure.kind as TurnFailureKind)) return false;
  if (failure.kind === "limit")
    return failure.scope === "credential" || failure.scope === "cocalc";
  return true;
}

const optionalBoolean = (value: unknown) =>
  value === undefined || typeof value === "boolean";

/** A stored or received outcome, if it is one; undefined otherwise. */
export function parseTurnOutcome(value: unknown): TurnOutcome | undefined {
  let data = value;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  if (!data || typeof data !== "object") return undefined;
  const outcome = data as Record<string, any>;
  if (outcome.version !== 1) return undefined;
  switch (outcome.state) {
    case "completed":
      return outcome as TurnOutcome;
    case "failed":
      return validFailure(outcome.failure) && optionalBoolean(outcome.tool_ran)
        ? (outcome as TurnOutcome)
        : undefined;
    case "canceled":
      return ["person", "sender", "superseded", "system"].includes(
        outcome.by,
      ) && optionalBoolean(outcome.tool_ran)
        ? (outcome as TurnOutcome)
        : undefined;
    case "never-started":
      return ["project-stopped", "host-lost", "expired", "canceled"].includes(
        outcome.reason,
      )
        ? (outcome as TurnOutcome)
        : undefined;
    default:
      return undefined;
  }
}

// An agent adapter attaches what it knows about a failure to the error it
// throws, so the host does not have to guess from the message.
const TURN_FAILURE = "cocalcTurnFailure";

export function withTurnFailure<E>(error: E, failure: TurnFailure): E {
  if (error && typeof error === "object")
    (error as Record<string, unknown>)[TURN_FAILURE] = failure;
  return error;
}

export function turnFailureOf(error: unknown): TurnFailure | undefined {
  if (!error || typeof error !== "object") return undefined;
  const failure = (error as Record<string, unknown>)[TURN_FAILURE];
  return validFailure(failure) ? failure : undefined;
}
