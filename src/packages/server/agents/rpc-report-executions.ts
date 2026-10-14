/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A delivery report starts at most one turn. The sender's host holds the
// report (and so its capability) once it has written it, so the capability
// alone could start any number; this record, kept until after the
// capability expired, is what makes it one.

import { agentStore } from "./store";
import { AGENT_RPC_REPORT_MAX_AGE_MS } from "./rpc-report-capability";

export interface AgentRpcReportExecution {
  attempt_id: string;
  report_id: string;
  account_id: string;
  project_id: string;
  host_id: string;
  path: string;
  thread_id: string;
}

/** Record the one turn of this message's report; false if it already ran. */
export async function claimAgentRpcReportExecution(
  execution: AgentRpcReportExecution,
): Promise<boolean> {
  const { rows } = await agentStore().query(
    `INSERT INTO agent_rpc_report_executions
     (attempt_id,report_id,account_id,project_id,host_id,path,thread_id,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8::bigint*interval '1 millisecond')
     ON CONFLICT (attempt_id) DO NOTHING
     RETURNING attempt_id`,
    [
      execution.attempt_id,
      execution.report_id,
      execution.account_id,
      execution.project_id,
      execution.host_id,
      execution.path,
      execution.thread_id,
      AGENT_RPC_REPORT_MAX_AGE_MS + 24 * 60 * 60_000,
    ],
  );
  return rows.length === 1;
}
