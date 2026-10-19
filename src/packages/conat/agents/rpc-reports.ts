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
  | "superseded";

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

/**
 * The report shape a sender's host can render, as it advertises in its
 * heartbeat (agent_rpc_report_version). 1 (no advertisement): the first five
 * kinds, no resets_at or tool_ran, and a text that always says the recipient
 * "did not act" and invites a resend.
 */
export const AGENT_RPC_REPORT_VERSION = 2;
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
  const { resets_at: _r, tool_ran, ...v1 } = report;
  // The recipient ran tools: the old "did not act" would invite a duplicate.
  if (tool_ran === true) return undefined;
  // Unknown: as such reports always were (an older recipient host never
  // says), only for the kinds it knew.
  if (tool_ran === undefined)
    return V1_KINDS.includes(report.kind) ? v1 : undefined;
  // Nothing ran, so its old "you can send it again" is true.
  if (V1_KINDS.includes(report.kind)) return v1;
  return {
    ...v1,
    kind: "error",
    detail: agentRpcReportDetail(
      `${KIND_TEXT[report.kind]}${report.detail ? `: ${report.detail}` : ""}`,
    ),
  };
  return undefined;
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
    "kind" | "detail" | "resets_at" | "tool_ran"
  >,
  targetLabel: string,
  now = Date.now(),
): string {
  const B = targetLabel;
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
    ],
    "delivery report",
  );
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
