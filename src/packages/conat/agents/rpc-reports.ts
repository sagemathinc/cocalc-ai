/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A delivery report: agent A's message started a turn of agent B, the turn
// ended in an error, and B never replied to A. CoCalc (not B) tells A, so A
// is not left waiting for an answer that will never come.
//
// The report is authorized by A's original message (the execution
// authorization B's host holds), rechecked by the hub when it is reported and
// again when the turn it starts for A runs. A report never causes another
// report: a turn it starts has no agent_rpc_execution.

import {
  turnFailureFromText,
  type TurnFailure,
  type TurnOutcome,
} from "@cocalc/conat/ai/acp/turn-outcome";
import { requireUuid } from "./protocol";
import { validateAgentEndpoint, validateAgentRpcSource } from "./rpc";
import type { AcpChatContext } from "@cocalc/conat/ai/acp/types";

export type AgentRpcExecution = NonNullable<
  AcpChatContext["agent_rpc_execution"]
>;

/** How the turn ended without a reply; always safe to tell the sender. */
export type AgentRpcTurnFailureKind =
  | "refused"
  | "limit"
  | "sign-in"
  | "timeout"
  | "error"
  | "project-stopped"
  | "host-lost"
  /** Someone in the recipient's project canceled the message before it ran. */
  | "canceled"
  /** Someone in the recipient's project stopped the turn while it ran. */
  | "stopped"
  /** A newer message in the recipient's conversation came first, so the
   * interrupted turn is not resumed. */
  | "superseded"
  /** The turn ended normally without replying, and the sender asked to be
   * told (agent send --report-no-reply). */
  | "completed";

export interface AgentRpcTurnFailureReport {
  version: 1;
  /** This report; repeats of it are the same report. */
  report_id: string;
  /** A's original message (its send attempt). */
  attempt_id: string;
  /** A's message's execution authorization, as B's host admitted it. */
  authorization: AgentRpcExecution;
  /** When B's turn started (ms); a reply from B after this means it replied. */
  turn_started_at: number;
  kind: AgentRpcTurnFailureKind;
  /** The error, one line and short. */
  detail?: string;
  /** For a limit: when it resets (ms), if known. */
  resets_at?: number;
  /** Whether the recipient ran any tool before the turn ended, if known. */
  tool_ran?: boolean;
  /** "held": not the end. The turn stopped (a usage limit) and resumes on
   * its own at resets_at; a final report follows only if it then ends
   * without replying. Absent: the turn is over. */
  phase?: "held";
}

/** What A's host is asked to deliver; labels are the account's own names. */
export interface AgentRpcReportDelivery {
  account_id: string;
  report: AgentRpcTurnFailureReport;
  /** A's chat, checked against A's identity by the hub. */
  path: string;
  thread_id: string;
  /** How A's network knows B, e.g. "@reviewer". */
  target_label: string;
}

export type AgentRpcReportDeliveryResult =
  | { message_id: string }
  | { skipped: "replied" | "duplicate" }
  | { not_sent: string };

export const AGENT_RPC_REPORT_DETAIL_MAX = 300;

/** How long a message's report capability is accepted after it was issued
 * (when the message was admitted): a report after that is refused. */
export const AGENT_RPC_REPORT_CAPABILITY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** When this capability stops being accepted, or undefined. */
export function agentRpcReportCapabilityExpiresAt(
  capability: string | undefined,
): number | undefined {
  const issued_at = Number(`${capability ?? ""}`.split(".")[0]);
  return Number.isSafeInteger(issued_at) && issued_at > 0
    ? issued_at + AGENT_RPC_REPORT_CAPABILITY_MAX_AGE_MS
    : undefined;
}

/**
 * The report shape a sender's host can render, as it advertises in its
 * heartbeat (agent_rpc_report_version). 1 (no advertisement): the first five
 * kinds, no resets_at or tool_ran, and a text that always says the recipient
 * "did not act" and invites a resend.
 */
export const AGENT_RPC_REPORT_VERSION = 4;
const V1_KINDS: AgentRpcTurnFailureKind[] = [
  "refused",
  "limit",
  "sign-in",
  "timeout",
  "error",
];

/**
 * A report for a sender's host that renders only version `version`, or
 * undefined to hold it until that host is upgraded: an old host's text
 * would invite a resend, which is unsafe once the recipient may have acted.
 */
export function agentRpcReportForVersion(
  report: AgentRpcTurnFailureReport,
  version: number,
): AgentRpcTurnFailureReport | undefined {
  if (version >= AGENT_RPC_REPORT_VERSION) return report;
  // Held reports (phase) came in version 4: an older host rejects them.
  if (report.phase === "held") return undefined;
  if (version >= 3) return report;
  // Before version 3 every report says the turn is over and did not succeed.
  if (report.kind === "completed") return undefined;
  if (version >= 2) return report;
  const { resets_at: _r, tool_ran, ...v1 } = report;
  // Only when nothing ran is the old text ("did not act ... you can send
  // it again") true; otherwise it would invite a duplicate.
  if (tool_ran !== false) return undefined;
  if (V1_KINDS.includes(report.kind)) return v1;
  return {
    ...v1,
    kind: "error",
    detail: agentRpcReportDetail(
      `${KIND_TEXT[report.kind]}${report.detail ? `: ${report.detail}` : ""}`,
    ),
  };
}

const KIND_TEXT: Record<AgentRpcTurnFailureKind, string> = {
  refused: "the model refused the request (a safety check)",
  limit: "a usage, credit or subscription limit",
  "sign-in": "its sign-in or credentials need attention",
  timeout: "it timed out",
  error: "an error",
  "project-stopped": "its project was stopped",
  "host-lost": "its runtime was lost (for example, its host restarted)",
  canceled: "someone in its project canceled your message before it ran",
  stopped: "someone in its project stopped the turn",
  superseded:
    "it was cut off, and a newer message in its conversation came first, so it is not resumed",
  completed: "it finished its turn without replying to you",
};

/** The report's kind for a turn's typed failure (turn-outcome.ts). */
export function agentRpcReportKind(
  failure: TurnFailure,
): AgentRpcTurnFailureKind {
  return failure.kind;
}

/** The report's kind for a turn that ended without success, if any. */
export function agentRpcReportKindOf(
  outcome: TurnOutcome,
): AgentRpcTurnFailureKind | undefined {
  switch (outcome.state) {
    case "completed":
      return undefined;
    case "failed":
      return agentRpcReportKind(outcome.failure);
    case "canceled":
      return outcome.by === "superseded"
        ? "superseded"
        : outcome.by === "person"
          ? "stopped"
          : "error";
    case "never-started":
      return outcome.reason === "canceled"
        ? "canceled"
        : outcome.reason === "project-stopped" || outcome.reason === "host-lost"
          ? outcome.reason
          : "error";
  }
}

/** Sort an error message into a kind; the text itself may say more. */
export function classifyAgentTurnError(error: string): AgentRpcTurnFailureKind {
  return agentRpcReportKind(turnFailureFromText(error));
}

/** One short line, so a long error cannot flood the sender's thread. */
export function agentRpcReportDetail(error: string): string {
  const line = error.replace(/\s+/g, " ").trim();
  return line.length > AGENT_RPC_REPORT_DETAIL_MAX
    ? `${line.slice(0, AGENT_RPC_REPORT_DETAIL_MAX - 1)}…`
    : line;
}

function inAbout(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/** The message A receives. */
export function agentRpcReportText(
  report: Pick<
    AgentRpcTurnFailureReport,
    "kind" | "detail" | "resets_at" | "tool_ran" | "phase"
  >,
  targetLabel: string,
  now = Date.now(),
): string {
  const B = targetLabel;
  if (report.phase === "held") {
    const at = report.resets_at
      ? `${new Date(report.resets_at).toISOString()}${report.resets_at > now ? ` (in about ${inAbout(report.resets_at - now)})` : ""}`
      : "soon";
    const signIn = report.kind === "sign-in";
    return [
      signIn
        ? `[Delivery report] ${B} stopped working on your message because its sign-in needs renewing. Its turn is paused, not over: CoCalc resumes it automatically once its owner signs in again, or gives up at ${at}.`
        : `[Delivery report] ${B} stopped working on your message because ${KIND_TEXT[report.kind] ?? "an error"} was reached. Its turn is paused, not over: CoCalc resumes it automatically at ${at}.`,
      `You will get another report only if that resumed turn ends without replying to you.`,
      `If you cannot wait, send the work to another agent instead (and tell ${B}), or carry on without it.`,
      `This report is from CoCalc, not from ${B}.`,
    ].join("\n");
  }
  if (report.kind === "completed")
    return [
      `[Delivery report] ${B} finished its turn on your message without replying to you (you asked to be told).`,
      `It may have done what you asked without writing back, so check before you send it again.`,
      `This report is from CoCalc, not from ${B}.`,
    ].join("\n");
  const failure = !["canceled", "stopped", "superseded"].includes(report.kind);
  const lines = [
    failure
      ? `[Delivery report] ${B}'s turn ended before it replied to your message: ${KIND_TEXT[report.kind] ?? "an error"}.`
      : `[Delivery report] ${B} did not reply to your message: ${KIND_TEXT[report.kind]}.`,
  ];
  if (report.resets_at) {
    const at = new Date(report.resets_at).toISOString();
    lines.push(
      report.resets_at > now
        ? `The limit resets at ${at} (in about ${inAbout(report.resets_at - now)}).`
        : `The limit was due to reset at ${at}.`,
    );
  }
  if (report.detail && failure) lines.push(`Error: ${report.detail}`);
  if (report.tool_ran === true)
    lines.push(
      `${B} had already started working on it (it ran tools), so check what it did before you send it again.`,
    );
  else if (report.tool_ran === false || report.kind === "canceled")
    lines.push(
      `${B} had not started working on it, so it is safe to send it again.`,
    );
  else
    lines.push(
      `It is not known whether ${B} had started working on it, so check before you send it again.`,
    );
  lines.push(
    `This report is from CoCalc, not from ${B}. You can send it again${report.resets_at ? " after the reset" : ""}, send it to another agent, rephrase it, or do without.`,
  );
  return lines.join("\n");
}

function onlyFields(value: object, fields: string[], name: string) {
  for (const key of Object.keys(value))
    if (!fields.includes(key)) throw new Error(`unexpected ${name} field`);
}

/**
 * The immutable binding of an admitted message that a report capability
 * signs: everything that says who sent what to whom, where, under which
 * network generation. Stable regardless of object key order.
 */
export function agentRpcReportBinding(value: AgentRpcExecution): string {
  const source = value.source as any;
  return JSON.stringify([
    "agent-rpc-report-v1",
    value.attempt_id ?? null,
    source.kind === "external"
      ? ["external", source.account_id, source.agent_id, source.installation_id]
      : [source.project_id, source.agent_id],
    value.source_run_id ?? null,
    value.target.project_id,
    value.target.agent_id,
    value.target_path,
    value.target_thread_id,
    value.agent_network_id,
    value.network_generation,
    value.account_generation,
    value.configured_delivery,
    value.principal_account_id,
    value.guidance === true,
  ]);
}

/** "<issued at, ms>.<HMAC>", minted by the hub (server/agents/rpc-report-capability.ts). */
export const AGENT_RPC_REPORT_CAPABILITY = /^[0-9]{13}\.[A-Za-z0-9_-]{43}$/;

export function validateAgentRpcExecution(value: AgentRpcExecution): void {
  if (!value || typeof value !== "object" || value.version !== 3)
    throw new Error("invalid agent message authorization");
  validateAgentRpcSource(value.source, value.source_run_id);
  validateAgentEndpoint(value.target);
  requireUuid(value.agent_network_id, "agent_network_id");
  requireUuid(value.principal_account_id, "principal_account_id");
  if (value.attempt_id !== undefined)
    requireUuid(value.attempt_id, "attempt_id");
  if (
    value.report_capability !== undefined &&
    (typeof value.report_capability !== "string" ||
      !AGENT_RPC_REPORT_CAPABILITY.test(value.report_capability))
  )
    throw new Error("invalid report_capability");
  for (const key of ["target_path", "target_thread_id", "network_generation"])
    if (typeof (value as any)[key] !== "string" || !(value as any)[key])
      throw new Error(`invalid ${key}`);
  if (!Number.isSafeInteger(value.account_generation))
    throw new Error("invalid account_generation");
  if (
    value.configured_delivery !== "queued" &&
    value.configured_delivery !== "live"
  )
    throw new Error("invalid configured_delivery");
  if (typeof value.guidance !== "boolean") throw new Error("invalid guidance");
  if (value.report_no_reply !== undefined && value.report_no_reply !== true)
    throw new Error("invalid report_no_reply");
}

export function validateAgentRpcTurnFailureReport(
  report: AgentRpcTurnFailureReport,
): void {
  if (!report || typeof report !== "object" || report.version !== 1)
    throw new Error("invalid delivery report");
  onlyFields(
    report,
    [
      "version",
      "report_id",
      "attempt_id",
      "authorization",
      "turn_started_at",
      "kind",
      "detail",
      "resets_at",
      "tool_ran",
      "phase",
    ],
    "delivery report",
  );
  if (report.phase !== undefined && report.phase !== "held")
    throw new Error("invalid phase");
  requireUuid(report.report_id, "report_id");
  requireUuid(report.attempt_id, "attempt_id");
  validateAgentRpcExecution(report.authorization);
  if (report.authorization.attempt_id !== report.attempt_id)
    throw new Error("delivery report names another message");
  if (!report.authorization.report_capability)
    throw new Error("delivery report without the hub's capability");
  // Only a queued message starts a turn of its own.
  if (report.authorization.guidance)
    throw new Error("guidance does not start a turn");
  if (
    !Number.isSafeInteger(report.turn_started_at) ||
    report.turn_started_at <= 0
  )
    throw new Error("invalid turn_started_at");
  if (!Object.prototype.hasOwnProperty.call(KIND_TEXT, report.kind))
    throw new Error("invalid kind");
  if (
    report.detail !== undefined &&
    (typeof report.detail !== "string" ||
      report.detail.length > AGENT_RPC_REPORT_DETAIL_MAX ||
      /[\r\n]/.test(report.detail))
  )
    throw new Error("invalid detail");
  if (
    report.resets_at !== undefined &&
    (!Number.isSafeInteger(report.resets_at) || report.resets_at <= 0)
  )
    throw new Error("invalid resets_at");
  if (report.tool_ran !== undefined && typeof report.tool_ran !== "boolean")
    throw new Error("invalid tool_ran");
}
