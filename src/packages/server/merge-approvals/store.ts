/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/*
Merge approval records on the seed bay. The database triggers in
database/postgres/schema/merge-approval-integrity.ts enforce the state
machine and append-only history; this refuses to write while they are not in
force, and checks the same rules first to give clear errors.
*/

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "@cocalc/database/pool";
import { assertMergeApprovalIntegrity } from "@cocalc/database/postgres/schema/merge-approval-integrity";
import {
  MAX_NEW_MERGE_APPROVALS_PER_PROJECT_PER_HOUR,
  MAX_PENDING_MERGE_APPROVALS_PER_PROJECT,
  MERGE_APPROVAL_TTL_MS,
  type MergeApprovalChatRef,
  type MergeApprovalDecision,
  type MergeApprovalDecisionKind,
  type MergeApprovalGitHubSnapshot,
  type MergeApprovalRequest,
  type MergeApprovalRequester,
} from "@cocalc/util/merge-approval";

export interface NewMergeApprovalRequest {
  repo: string;
  pr_number: number;
  head_sha: string;
  base_ref: string;
  github_snapshot: MergeApprovalGitHubSnapshot;
  agent_note: string;
  requested_by: MergeApprovalRequester;
  chat?: MergeApprovalChatRef;
}

function codeError(message: string, code: string | number): Error {
  return Object.assign(new Error(message), { code });
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : `${value ?? ""}`;
}

function toRequest(row: any): MergeApprovalRequest {
  return {
    id: row.id,
    repo: row.repo,
    pr_number: row.pr_number,
    head_sha: row.head_sha,
    base_ref: row.base_ref,
    github_snapshot: row.github_snapshot,
    agent_note: row.agent_note ?? "",
    requested_by: row.requested_by,
    chat: row.chat ?? undefined,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    status: row.status,
  };
}

function toDecision(row: any): MergeApprovalDecision {
  return {
    id: row.id,
    request_id: row.request_id,
    account_id: row.account_id,
    decision: row.decision,
    comment: row.comment ?? "",
    session_hash: row.session_hash,
    factor_level: row.factor_level,
    decided_at: iso(row.decided_at),
  };
}

export class MergeApprovalStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertMergeApprovalIntegrity(client);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<MergeApprovalRequest | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM merge_approval_requests WHERE id=$1",
      [id],
    );
    return rows[0] == null ? undefined : toRequest(rows[0]);
  }

  // Records a new pending request, or returns the requesting project's open
  // request for the same head. Open requests for an older head of the same
  // pull request are superseded: the caller has just read the new head from
  // GitHub.
  //
  // verify runs while this pull request's lock is held, before anything is
  // written: the caller re-reads the head there, so a slower request for an
  // older head can't supersede a newer one that got in first.
  async create(
    req: NewMergeApprovalRequest,
    { verify }: { verify?: () => Promise<void> } = {},
  ): Promise<MergeApprovalRequest> {
    const project_id = req.requested_by.project_id;
    return await this.transaction(async (client) => {
      // Serialize requests for one pull request (from any project), so only
      // the newest head stays open, and then one project's requests, so they
      // can't race the limits. Always in this order, so they can't deadlock.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `merge-approval-pr:${req.repo}#${req.pr_number}`,
      ]);
      await verify?.();
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `merge-approval-request:${project_id}`,
      ]);
      await client.query(
        `UPDATE merge_approval_requests SET status='expired'
          WHERE status='pending' AND expires_at <= now()
            AND requested_by->>'project_id' = $1`,
        [project_id],
      );
      const existing = await client.query(
        `SELECT * FROM merge_approval_requests
          WHERE status='pending' AND repo=$1 AND pr_number=$2 AND head_sha=$3
            AND requested_by->>'project_id' = $4
          ORDER BY created_at DESC LIMIT 1`,
        [req.repo, req.pr_number, req.head_sha, project_id],
      );
      if (existing.rows[0] != null) return toRequest(existing.rows[0]);

      // Supersede first, so a request for a new head frees its old head's
      // slot. If a limit refuses it below, this rolls back too.
      await client.query(
        `UPDATE merge_approval_requests SET status='superseded'
          WHERE status='pending' AND repo=$1 AND pr_number=$2 AND head_sha<>$3`,
        [req.repo, req.pr_number, req.head_sha],
      );
      const counts = await client.query(
        `SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
                count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS recent
           FROM merge_approval_requests
          WHERE requested_by->>'project_id' = $1
            AND (status='pending' OR created_at > now() - interval '1 hour')`,
        [project_id],
      );
      const { pending, recent } = counts.rows[0] ?? { pending: 0, recent: 0 };
      if (pending >= MAX_PENDING_MERGE_APPROVALS_PER_PROJECT) {
        throw codeError(
          `this project already has ${pending} open merge approval requests`,
          429,
        );
      }
      if (recent >= MAX_NEW_MERGE_APPROVALS_PER_PROJECT_PER_HOUR) {
        throw codeError(
          "too many merge approval requests from this project in the last hour",
          429,
        );
      }

      const { rows } = await client.query(
        `INSERT INTO merge_approval_requests
           (id, repo, pr_number, head_sha, base_ref, github_snapshot,
            agent_note, requested_by, chat, created_at, expires_at, status)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,now(),
                 now() + ($10::bigint * interval '1 millisecond'),'pending')
         RETURNING *`,
        [
          randomUUID(),
          req.repo,
          req.pr_number,
          req.head_sha,
          req.base_ref,
          JSON.stringify(req.github_snapshot),
          req.agent_note,
          JSON.stringify(req.requested_by),
          req.chat == null ? null : JSON.stringify(req.chat),
          MERGE_APPROVAL_TTL_MS,
        ],
      );
      return toRequest(rows[0]);
    });
  }

  // Records one decision for a pending, unexpired request and moves it to
  // approved or rejected. A request past its expiry is marked expired
  // instead, and the decision refused.
  async decide({
    request_id,
    account_id,
    decision,
    comment,
    session_hash,
    factor_level,
  }: {
    request_id: string;
    account_id: string;
    decision: MergeApprovalDecisionKind;
    comment: string;
    session_hash: string;
    factor_level: string;
  }): Promise<{
    request: MergeApprovalRequest;
    decision: MergeApprovalDecision;
  }> {
    let expired = false;
    const result = await this.transaction(async (client) => {
      const { rows } = await client.query(
        `SELECT *, expires_at <= now() AS is_expired
           FROM merge_approval_requests WHERE id=$1 FOR UPDATE`,
        [request_id],
      );
      const row = rows[0];
      if (row == null) {
        throw codeError("merge approval request not found", 404);
      }
      if (row.status !== "pending") {
        throw codeError(
          `merge approval request is ${row.status}, not pending`,
          "not_pending",
        );
      }
      if (row.is_expired) {
        await client.query(
          "UPDATE merge_approval_requests SET status='expired' WHERE id=$1",
          [request_id],
        );
        expired = true;
        return undefined;
      }
      const inserted = await client.query(
        `INSERT INTO merge_approval_decisions
           (id, request_id, account_id, decision, comment, session_hash,
            factor_level, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         RETURNING *`,
        [
          randomUUID(),
          request_id,
          account_id,
          decision,
          comment,
          session_hash,
          factor_level,
        ],
      );
      const updated = await client.query(
        "UPDATE merge_approval_requests SET status=$2 WHERE id=$1 RETURNING *",
        [request_id, decision === "approve" ? "approved" : "rejected"],
      );
      return {
        request: toRequest(updated.rows[0]),
        decision: toDecision(inserted.rows[0]),
      };
    });
    if (expired || result == null) {
      throw codeError("merge approval request has expired", "expired");
    }
    return result;
  }
}
