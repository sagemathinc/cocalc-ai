/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A report capability is the hub's HMAC over an admitted message's binding
// (conat/agents/rpc-reports.ts agentRpcReportBinding) and the time it was
// minted, when the hub submits a queued message to the recipient's host. A
// delivery report must carry it, so a host can report only a message it was
// actually sent, with exactly that sender, recipient, chat and network
// generation, and only for a while: the one turn a report may start is
// recorded until well after its capability expired (rpc-report-executions.ts).

import { createHmac, timingSafeEqual } from "node:crypto";
import { conatPassword } from "@cocalc/backend/data";
import { getClusterConfig } from "@cocalc/server/cluster-config";
import {
  AGENT_RPC_REPORT_CAPABILITY,
  agentRpcReportBinding,
  type AgentRpcExecution,
} from "@cocalc/conat/agents/rpc-reports";

/** A message older than this is no longer reported. */
export const AGENT_RPC_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
// Tolerated clock skew between the bays that mint and check.
const SKEW_MS = 5 * 60_000;

function key(): Buffer {
  // Every bay of a cluster has the same one; a standalone hub has only its
  // own conat password (as for home-bay retry tokens).
  let secret = `${process.env.COCALC_CLUSTER_SHARED_SECRET ?? ""}`.trim();
  if (!secret) {
    if (getClusterConfig().role !== "standalone")
      throw new Error("missing COCALC_CLUSTER_SHARED_SECRET");
    secret = `${conatPassword ?? ""}`.trim();
  }
  if (!secret) throw new Error("no secret to sign agent report capabilities");
  // A key for this purpose only.
  return createHmac("sha256", secret)
    .update("cocalc-agent-rpc-report-capability-v1")
    .digest();
}

function mac(execution: AgentRpcExecution, issued_at: number): string {
  return createHmac("sha256", key())
    .update(`${issued_at}\n${agentRpcReportBinding(execution)}`)
    .digest("base64url");
}

export function signAgentRpcReportCapability(
  execution: AgentRpcExecution,
  issued_at = Date.now(),
): string {
  return `${issued_at}.${mac(execution, issued_at)}`;
}

/** When the capability was minted, if it is the hub's, exactly as minted. */
export function verifyAgentRpcReportCapability(
  execution: AgentRpcExecution,
  now = Date.now(),
): boolean {
  const capability = `${execution.report_capability ?? ""}`;
  if (!AGENT_RPC_REPORT_CAPABILITY.test(capability)) return false;
  const [issued, given] = capability.split(".");
  const issued_at = Number(issued);
  if (
    !Number.isSafeInteger(issued_at) ||
    issued_at > now + SKEW_MS ||
    now - issued_at > AGENT_RPC_REPORT_MAX_AGE_MS
  )
    return false;
  let expected: string;
  try {
    expected = mac(execution, issued_at);
  } catch {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
