/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { agentStore } from "./store";

export type AgentRpcAdmissionKind = "permit" | "preparation";

export interface AgentRpcAdmissionState {
  token_id: string;
  kind: AgentRpcAdmissionKind;
  binding_hash: string;
  host_id: string;
  project_id: string;
  account_id: string;
  expires_at: Date;
}

const MAX_ACTIVE_BY_KIND: Record<AgentRpcAdmissionKind, number> = {
  permit: 1000,
  preparation: 1000,
};
const MAX_ACTIVE_BY_ACCOUNT: Record<AgentRpcAdmissionKind, number> = {
  permit: 8,
  preparation: 4,
};
const MAX_ACTIVE_BY_PROJECT: Record<AgentRpcAdmissionKind, number> = {
  permit: 4,
  preparation: 2,
};

export const hashAgentRpcAdmissionBinding = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export async function createAgentRpcAdmissionState(
  state: AgentRpcAdmissionState,
): Promise<void> {
  const expiresAt = state.expires_at.getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
    throw new Error("agent RPC admission state already expired");
  await agentStore().transaction(async (db) => {
    // Capacity must be shared by every load-balanced hub process on this bay.
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('agent-rpc-admission-capacity-v1'))",
    );
    await db.query(
      "DELETE FROM agent_rpc_admission_state WHERE expires_at<=now()",
    );
    const counts = (
      await db.query<{
        total: string;
        account_total: string;
        project_total: string;
      }>(
        `SELECT
           count(*)::text AS total,
           count(*) FILTER (WHERE account_id=$2)::text AS account_total,
           count(*) FILTER (WHERE project_id=$3)::text AS project_total
         FROM agent_rpc_admission_state WHERE kind=$1`,
        [state.kind, state.account_id, state.project_id],
      )
    ).rows[0];
    if (Number(counts?.total ?? 0) >= MAX_ACTIVE_BY_KIND[state.kind])
      throw new Error(
        state.kind === "permit"
          ? "too many in-flight submissions"
          : "attachment preparation capacity full",
      );
    if (Number(counts?.account_total ?? 0) >= MAX_ACTIVE_BY_ACCOUNT[state.kind])
      throw new Error("agent RPC principal capacity full");
    if (Number(counts?.project_total ?? 0) >= MAX_ACTIVE_BY_PROJECT[state.kind])
      throw new Error("recipient project messaging capacity full");
    await db.query(
      `INSERT INTO agent_rpc_admission_state
       (token_id,kind,binding_hash,host_id,project_id,account_id,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        state.token_id,
        state.kind,
        state.binding_hash,
        state.host_id,
        state.project_id,
        state.account_id,
        state.expires_at,
      ],
    );
  });
}

export async function getAgentRpcAdmissionState({
  token_id,
  kind,
}: {
  token_id: string;
  kind: AgentRpcAdmissionKind;
}): Promise<AgentRpcAdmissionState | undefined> {
  return (
    await agentStore().query<AgentRpcAdmissionState>(
      `SELECT token_id,kind,binding_hash,host_id,project_id,account_id,expires_at
       FROM agent_rpc_admission_state
       WHERE token_id=$1 AND kind=$2 AND expires_at>now()`,
      [token_id, kind],
    )
  ).rows[0];
}

export async function claimAgentRpcAdmissionState({
  token_id,
  kind,
  binding_hash,
  host_id,
  project_id,
  account_id,
}: Pick<
  AgentRpcAdmissionState,
  "token_id" | "kind" | "binding_hash" | "host_id" | "project_id" | "account_id"
>): Promise<AgentRpcAdmissionState | undefined> {
  return (
    await agentStore().query<AgentRpcAdmissionState>(
      `DELETE FROM agent_rpc_admission_state
       WHERE token_id=$1 AND kind=$2 AND binding_hash=$3 AND host_id=$4
         AND project_id=$5 AND account_id=$6 AND expires_at>now()
       RETURNING token_id,kind,binding_hash,host_id,project_id,account_id,expires_at`,
      [token_id, kind, binding_hash, host_id, project_id, account_id],
    )
  ).rows[0];
}

export async function deleteAgentRpcAdmissionState({
  token_id,
  kind,
}: {
  token_id: string;
  kind: AgentRpcAdmissionKind;
}): Promise<void> {
  await agentStore().query(
    "DELETE FROM agent_rpc_admission_state WHERE token_id=$1 AND kind=$2",
    [token_id, kind],
  );
}
