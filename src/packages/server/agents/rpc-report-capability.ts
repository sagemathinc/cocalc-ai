/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A report capability is the hub's HMAC over an admitted message's binding
// (conat/agents/rpc-reports.ts agentRpcReportBinding), minted when the hub
// submits a queued message to the recipient's host. A delivery report must
// carry it, so a host can report only a message it was actually sent, with
// exactly that sender, recipient, chat and network generation.

import { createHmac, timingSafeEqual } from "node:crypto";
import { conatPassword } from "@cocalc/backend/data";
import {
  agentRpcReportBinding,
  type AgentRpcExecution,
} from "@cocalc/conat/agents/rpc-reports";

function key(): Buffer {
  const secret =
    `${process.env.COCALC_CLUSTER_SHARED_SECRET ?? ""}`.trim() ||
    `${conatPassword ?? ""}`.trim();
  if (!secret) throw new Error("no secret to sign agent report capabilities");
  // A key for this purpose only.
  return createHmac("sha256", secret)
    .update("cocalc-agent-rpc-report-capability-v1")
    .digest();
}

export function signAgentRpcReportCapability(
  execution: AgentRpcExecution,
): string {
  return createHmac("sha256", key())
    .update(agentRpcReportBinding(execution))
    .digest("base64url");
}

export function verifyAgentRpcReportCapability(
  execution: AgentRpcExecution,
): boolean {
  const given = Buffer.from(`${execution.report_capability ?? ""}`);
  let expected: Buffer;
  try {
    expected = Buffer.from(signAgentRpcReportCapability(execution));
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
