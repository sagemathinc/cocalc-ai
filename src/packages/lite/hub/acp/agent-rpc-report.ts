/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Delivery reports (conat/agents/rpc-reports.ts), on both hosts involved:
// - the recipient's host notes a failed turn that another agent's message
//   started, and sends the report to the hub until it is handled;
// - the sender's host writes the report into the sender's chat and wakes it,
//   unless the recipient replied after all.

import { randomUUID } from "node:crypto";
import type { Client } from "@cocalc/conat/core/client";
import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import { agentRpcSourceKey } from "@cocalc/conat/agents/rpc";
import {
  agentRpcReportDetail,
  agentRpcReportText,
  classifyAgentTurnError,
  type AgentRpcReportDelivery,
  type AgentRpcReportDeliveryResult,
  type AgentRpcTurnFailureReport,
} from "@cocalc/conat/agents/rpc-reports";
import { prepareChatSend, admitPreparedChatSend } from "@cocalc/chat/send";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import getLogger from "@cocalc/backend/logger";
import { getAcpJob } from "../sqlite/acp-jobs";
import {
  deleteAgentRpcReport,
  enqueueAgentRpcReport,
  listDueAgentRpcReports,
  retryAgentRpcReport,
} from "../sqlite/agent-rpc-reports";

const logger = getLogger("lite:hub:acp:agent-rpc-report");

const errorText = (err: unknown) =>
  `${err instanceof Error ? err.message : err}`.slice(0, 500);

/**
 * The recipient's side: a turn ended in an error. If another agent's queued
 * message started it, queue a report for that agent. A turn a report started
 * has no agent_rpc_execution, so reports never cause reports.
 */
export function noteAgentMessageTurnFailed(opts: {
  op_id: string;
  request: Pick<AcpRequest, "chat">;
  error: string;
  turn_started_at?: number | null;
  now?: number;
}): AgentRpcTurnFailureReport | undefined {
  const authorization = opts.request.chat?.agent_rpc_execution;
  // Without the hub's capability (a message admitted before reports
  // existed) the hub would refuse the report anyway.
  if (
    !authorization ||
    authorization.guidance ||
    !authorization.attempt_id ||
    !authorization.report_capability
  )
    return;
  const turn_started_at = Number(opts.turn_started_at ?? 0);
  if (!Number.isSafeInteger(turn_started_at) || turn_started_at <= 0) return;
  const detail = agentRpcReportDetail(opts.error);
  const report: AgentRpcTurnFailureReport = {
    version: 1,
    report_id: randomUUID(),
    attempt_id: authorization.attempt_id,
    authorization: { ...authorization },
    turn_started_at,
    kind: classifyAgentTurnError(opts.error),
    ...(detail ? { detail } : {}),
  };
  try {
    if (
      !enqueueAgentRpcReport({
        op_id: opts.op_id,
        account_id: authorization.principal_account_id,
        report,
        now: opts.now,
      })
    )
      return;
  } catch (err) {
    logger.warn("could not queue a delivery report", {
      op_id: opts.op_id,
      err: errorText(err),
    });
    return;
  }
  return report;
}

let draining: Promise<void> | undefined;

/**
 * Send due reports to the hub. Delivered, skipped and refused reports are
 * done; an unreachable hub is retried later (see retryAgentRpcReport).
 */
export function drainAgentRpcReports(
  api: Pick<AgentApi, "reportRpcTurnFailure">,
  now = Date.now(),
): Promise<void> {
  draining ??= (async () => {
    try {
      for (const row of listDueAgentRpcReports(now)) {
        try {
          const result = await api.reportRpcTurnFailure({
            account_id: row.account_id,
            report: row.report,
          });
          if ("not_sent" in result)
            logger.debug("delivery report not sent", {
              report_id: row.report_id,
              reason: result.not_sent,
            });
          deleteAgentRpcReport(row.report_id);
        } catch (err) {
          retryAgentRpcReport(row.report_id, errorText(err), now);
        }
      }
    } finally {
      draining = undefined;
    }
  })();
  return draining;
}

/**
 * The sender's side: write the report into the sender's chat and start a
 * turn for it. Like a sensor wake, failures before the message is written
 * are not_sent; later ones are thrown (the turn may already be queued).
 */
export async function deliverAgentRpcReport(
  client: Client,
  delivery: AgentRpcReportDelivery,
  ensureRunning: () => Promise<void>,
): Promise<AgentRpcReportDeliveryResult> {
  const { report } = delivery;
  const sender = report.authorization.source;
  const project_id = sender.project_id;
  if (!project_id) return { not_sent: "the sender is not a project agent" };
  const recipient = report.authorization.target;
  try {
    await ensureRunning();
  } catch (err) {
    return { not_sent: `the project did not start: ${errorText(err)}` };
  }
  let db: Awaited<ReturnType<typeof acquireChatSyncDB>>;
  try {
    db = await acquireChatSyncDB({
      client,
      project_id,
      path: delivery.path,
      readyTimeoutMs: 10_000,
    });
  } catch (err) {
    return { not_sent: `the agent's chat did not open: ${errorText(err)}` };
  }
  try {
    let prepared: ReturnType<typeof prepareChatSend>;
    let unadmitted: any;
    try {
      const current = db.get();
      const rows: any[] = Array.isArray(current)
        ? current
        : (current?.toJS?.() ?? []);
      const thread = rows.find(
        (row) =>
          row.event === "chat-thread-config" &&
          row.thread_id === delivery.thread_id,
      );
      if (!thread || thread.archived)
        return { not_sent: "the agent's thread is unavailable" };
      const recipientKey = agentRpcSourceKey(recipient);
      for (const row of rows) {
        if (row.event !== "chat" || row.thread_id !== delivery.thread_id)
          continue;
        const rpc = row.agent_rpc;
        if (rpc?.delivery_report?.attempt_id === report.attempt_id) {
          // A report whose admission was not confirmed is replaced below,
          // unless its turn was queued after all (the acknowledgement was
          // lost); any other is this report again.
          if (
            rpc.delivery_report.admission === "failed" &&
            !row.acp_state &&
            !getAcpJob({
              project_id,
              path: delivery.path,
              user_message_id: `${row.message_id ?? ""}`,
            })
          )
            unadmitted = row;
          else return { skipped: "duplicate" };
          continue;
        }
        // The recipient replied after all (its sends are saved here before
        // they are accepted, so before its turn could end).
        if (
          rpc?.source &&
          !rpc.delivery_report &&
          agentRpcSourceKey(rpc.source) === recipientKey &&
          new Date(row.date).valueOf() >= report.turn_started_at
        )
          return { skipped: "replied" };
      }
      prepared = prepareChatSend({
        projectId: project_id,
        accountId: delivery.account_id,
        path: delivery.path,
        thread,
        rows,
        prompt: agentRpcReportText(report, delivery.target_label),
      });
    } catch (err) {
      return { not_sent: errorText(err) };
    }
    // Written by CoCalc, not a person: the hub rechecks the report before
    // the turn executes, and a turn it starts is never itself reported.
    prepared.request.chat.agent_message = true;
    prepared.request.chat.agent_rpc_report = report;
    // Display metadata only, never an authorization input.
    const agent_rpc = {
      version: 3,
      source: { ...recipient },
      source_label: delivery.target_label,
      target: { ...sender },
      agent_network_id: report.authorization.agent_network_id,
      delivery_report: {
        report_id: report.report_id,
        attempt_id: report.attempt_id,
        kind: report.kind,
      },
    };
    if (unadmitted)
      db.delete({
        event: "chat",
        date: unadmitted.date,
        sender_id: unadmitted.sender_id,
        message_id: unadmitted.message_id,
        thread_id: unadmitted.thread_id,
      });
    db.set({ ...prepared.message, agent_rpc });
    db.commit();
    await db.save();
    await db.save_to_disk();
    try {
      await admitPreparedChatSend({ prepared, client, timeoutMs: 15_000 });
    } catch (err) {
      // Not confirmed: mark it, so the retry the hub's error causes replaces
      // it instead of taking it for a delivered report.
      db.set({
        ...prepared.message,
        agent_rpc: {
          ...agent_rpc,
          delivery_report: {
            ...agent_rpc.delivery_report,
            admission: "failed",
          },
        },
      });
      db.commit();
      await db.save();
      throw err;
    }
    return { message_id: `${prepared.message.message_id ?? ""}` };
  } finally {
    await releaseChatSyncDB(project_id, delivery.path);
  }
}
