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

import { requireUuid } from "./protocol";
import { validateAgentEndpoint, validateAgentRpcSource } from "./rpc";
import type { AcpChatContext } from "@cocalc/conat/ai/acp/types";

export type AgentRpcExecution = NonNullable<
  AcpChatContext["agent_rpc_execution"]
>;

/** What kind of error ended the turn; always safe to tell the sender. */
export type AgentRpcTurnFailureKind =
  | "refused"
  | "limit"
  | "sign-in"
  | "timeout"
  | "error";

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

const KIND_TEXT: Record<AgentRpcTurnFailureKind, string> = {
  refused: "the model refused the request (a safety check)",
  limit: "a usage, credit or subscription limit",
  "sign-in": "its sign-in or credentials need attention",
  timeout: "it timed out",
  error: "an error",
};

/** Sort an error message into a kind; the text itself may say more. */
export function classifyAgentTurnError(error: string): AgentRpcTurnFailureKind {
  const text = error.toLowerCase();
  if (
    /flagged|cybersecurity|safety|refus|policy violation|content policy|not allowed to/.test(
      text,
    )
  )
    return "refused";
  if (
    /usage limit|rate limit|quota|credit|insufficient|billing|subscription|payment|out of (?:funds|tokens)|limit reached|429/.test(
      text,
    )
  )
    return "limit";
  if (
    /sign[- ]?in|signed out|log ?in|unauthori[sz]ed|authenticat|expired token|token expired|api key|401|403/.test(
      text,
    )
  )
    return "sign-in";
  if (/timed? ?out|timeout|deadline exceeded/.test(text)) return "timeout";
  return "error";
}

/** One short line, so a long error cannot flood the sender's thread. */
export function agentRpcReportDetail(error: string): string {
  const line = error.replace(/\s+/g, " ").trim();
  return line.length > AGENT_RPC_REPORT_DETAIL_MAX
    ? `${line.slice(0, AGENT_RPC_REPORT_DETAIL_MAX - 1)}…`
    : line;
}

/** The message A receives. */
export function agentRpcReportText(
  report: Pick<AgentRpcTurnFailureReport, "kind" | "detail">,
  targetLabel: string,
): string {
  return [
    `[Delivery report] ${targetLabel}'s turn ended with an error before it replied to your message: ${KIND_TEXT[report.kind]}.`,
    ...(report.detail ? [`Error: ${report.detail}`] : []),
    `This report is from CoCalc, not from ${targetLabel}. ${targetLabel} did not act on your message; you can send it again, rephrase it, or do without.`,
  ].join("\n");
}

function onlyFields(value: object, fields: string[], name: string) {
  for (const key of Object.keys(value))
    if (!fields.includes(key)) throw new Error(`unexpected ${name} field`);
}

export function validateAgentRpcExecution(value: AgentRpcExecution): void {
  if (!value || typeof value !== "object" || value.version !== 3)
    throw new Error("invalid agent message authorization");
  validateAgentRpcSource(value.source, value.source_run_id);
  validateAgentEndpoint(value.target);
  requireUuid(value.agent_network_id, "agent_network_id");
  requireUuid(value.principal_account_id, "principal_account_id");
  if (value.attempt_id !== undefined)
    requireUuid(value.attempt_id, "attempt_id");
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
    ],
    "delivery report",
  );
  requireUuid(report.report_id, "report_id");
  requireUuid(report.attempt_id, "attempt_id");
  validateAgentRpcExecution(report.authorization);
  if (report.authorization.attempt_id !== report.attempt_id)
    throw new Error("delivery report names another message");
  // Only a queued message starts a turn of its own.
  if (report.authorization.guidance)
    throw new Error("guidance does not start a turn");
  if (
    !Number.isSafeInteger(report.turn_started_at) ||
    report.turn_started_at <= 0
  )
    throw new Error("invalid turn_started_at");
  if (!(report.kind in KIND_TEXT)) throw new Error("invalid kind");
  if (
    report.detail !== undefined &&
    (typeof report.detail !== "string" ||
      report.detail.length > AGENT_RPC_REPORT_DETAIL_MAX ||
      /[\r\n]/.test(report.detail))
  )
    throw new Error("invalid detail");
}
