/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
  assertMergeApprovalIntegrity,
  truncateTablesForTestReset,
  ensureMergeApprovalIntegritySchema,
  mergeApprovalIntegritySchemaNeedsSync,
} from "./merge-approval-integrity";

let syncedByInit = false;

beforeAll(async () => {
  await initEphemeralDatabase({});
  syncedByInit = !(await mergeApprovalIntegritySchemaNeedsSync(getPool()));
  const client = await getPool().connect();
  try {
    await ensureMergeApprovalIntegritySchema(client);
  } finally {
    client.release();
  }
}, 15_000);

afterAll(async () => {
  await testCleanup();
});

const q = (sql: string, params: any[] = []) => getPool().query(sql, params);

async function insertRequest({
  status = "pending",
  expires = "now() + interval '7 days'",
  created = "now()",
}: { status?: string; expires?: string; created?: string } = {}) {
  const id = uuid();
  await q(
    `INSERT INTO merge_approval_requests
       (id, repo, pr_number, head_sha, base_ref, github_snapshot, agent_note,
        requested_by, chat, created_at, expires_at, status)
     VALUES ($1, 'o/r', 1, $2, 'main', '{}'::jsonb, 'note', '{}'::jsonb, NULL,
             ${created}, ${expires}, $3)`,
    [id, "a".repeat(40), status],
  );
  return id;
}

async function insertDecision(
  request_id: string,
  decision = "approve",
  decided = "now()",
) {
  const id = uuid();
  await q(
    `INSERT INTO merge_approval_decisions
       (id, request_id, account_id, decision, comment, session_hash,
        factor_level, decided_at)
     VALUES ($1, $2, $3, $4, '', 'hash', 'totp', ${decided})`,
    [id, request_id, uuid(), decision],
  );
  return id;
}

async function insertRelay(decision_id: string, request_id: string) {
  await q(
    `INSERT INTO merge_approval_relays
       (id, decision_id, request_id, attempted_at, outcome)
     VALUES ($1, $2, $3, now(), 'posted')`,
    [uuid(), decision_id, request_id],
  );
}

describe("merge approval integrity triggers", () => {
  it("are installed by schema sync", async () => {
    expect(syncedByInit).toBe(true);
    await expect(
      mergeApprovalIntegritySchemaNeedsSync(getPool()),
    ).resolves.toBe(false);
    await expect(assertMergeApprovalIntegrity(getPool())).resolves.toBe(
      undefined,
    );
  });

  it("start requests pending", async () => {
    await expect(insertRequest({ status: "approved" })).rejects.toThrow(
      "start pending",
    );
  });

  it("keep request fields fixed except the status", async () => {
    const id = await insertRequest();
    for (const set of [
      `head_sha='${"b".repeat(40)}'`,
      "agent_note='changed'",
      "github_snapshot='{\"x\":1}'::jsonb",
      "expires_at=now() + interval '30 days'",
      'requested_by=\'{"project_id":"x"}\'::jsonb',
    ]) {
      await expect(
        q(`UPDATE merge_approval_requests SET ${set} WHERE id=$1`, [id]),
      ).rejects.toThrow("except their status");
    }
  });

  it("allow only forward status changes, with a decision for approved and rejected", async () => {
    const id = await insertRequest();
    await expect(
      q("UPDATE merge_approval_requests SET status='approved' WHERE id=$1", [
        id,
      ]),
    ).rejects.toThrow("needs a recorded decision");
    await insertDecision(id, "reject");
    await expect(
      q("UPDATE merge_approval_requests SET status='approved' WHERE id=$1", [
        id,
      ]),
    ).rejects.toThrow("needs a recorded decision");
    await q(
      "UPDATE merge_approval_requests SET status='rejected' WHERE id=$1",
      [id],
    );
    await expect(
      q("UPDATE merge_approval_requests SET status='pending' WHERE id=$1", [
        id,
      ]),
    ).rejects.toThrow("cannot go from rejected to pending");

    const approved = await insertRequest();
    await insertDecision(approved, "approve");
    await q(
      "UPDATE merge_approval_requests SET status='approved' WHERE id=$1",
      [approved],
    );
    await q(
      "UPDATE merge_approval_requests SET status='superseded' WHERE id=$1",
      [approved],
    );
    await expect(
      q("UPDATE merge_approval_requests SET status='approved' WHERE id=$1", [
        approved,
      ]),
    ).rejects.toThrow("cannot go from superseded to approved");
  });

  it("refuse a decision on a request that is not pending, or has expired", async () => {
    const decided = await insertRequest();
    await insertDecision(decided, "approve");
    await expect(insertDecision(decided, "approve")).rejects.toThrow();
    await q(
      "UPDATE merge_approval_requests SET status='approved' WHERE id=$1",
      [decided],
    );
    await expect(insertDecision(decided, "reject")).rejects.toThrow(
      "is approved, not pending",
    );

    const withdrawn = await insertRequest();
    await q(
      "UPDATE merge_approval_requests SET status='withdrawn' WHERE id=$1",
      [withdrawn],
    );
    await expect(insertDecision(withdrawn)).rejects.toThrow(
      "is withdrawn, not pending",
    );

    const expired = await insertRequest({
      expires: "now() - interval '1 second'",
    });
    await expect(insertDecision(expired)).rejects.toThrow("has expired");
    await expect(insertDecision(uuid())).rejects.toThrow(
      "unknown merge approval request",
    );
  });

  it("make decisions and relays append-only", async () => {
    const id = await insertRequest();
    const decision_id = await insertDecision(id, "approve");
    await expect(
      q("UPDATE merge_approval_decisions SET comment='x' WHERE id=$1", [
        decision_id,
      ]),
    ).rejects.toThrow("append-only");
    await expect(
      q("DELETE FROM merge_approval_decisions WHERE id=$1", [decision_id]),
    ).rejects.toThrow("kept for 13 months");

    await insertRelay(decision_id, id);
    await expect(
      q("UPDATE merge_approval_relays SET outcome='x' WHERE decision_id=$1", [
        decision_id,
      ]),
    ).rejects.toThrow("append-only");
    await expect(
      q("DELETE FROM merge_approval_relays WHERE decision_id=$1", [
        decision_id,
      ]),
    ).rejects.toThrow("kept for 13 months");
    await expect(
      q("DELETE FROM merge_approval_requests WHERE id=$1", [id]),
    ).rejects.toThrow("kept for 13 months");
  });

  it("relay only approve decisions of the same request", async () => {
    const id = await insertRequest();
    const reject_id = await insertDecision(id, "reject");
    await expect(insertRelay(reject_id, id)).rejects.toThrow(
      "need an approve decision",
    );
    const other = await insertRequest();
    const approve_id = await insertDecision(other, "approve");
    await expect(insertRelay(approve_id, id)).rejects.toThrow(
      "need an approve decision",
    );
  });

  it("refuse truncation", async () => {
    for (const table of [
      "merge_approval_relays",
      "merge_approval_decisions",
      "merge_approval_requests",
    ]) {
      await expect(q(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(
        "cannot be truncated",
      );
    }
  });

  it("allow deleting records only after the retention period", async () => {
    const id = await insertRequest({
      created: "now() - interval '14 months'",
      expires: "now() - interval '13 months'",
    });
    await q("DELETE FROM merge_approval_requests WHERE id=$1", [id]);
    const { rows } = await q(
      "SELECT 1 FROM merge_approval_requests WHERE id=$1",
      [id],
    );
    expect(rows).toEqual([]);
  });

  it("are reported when disabled or outdated, and writers refuse", async () => {
    await q(
      "ALTER TABLE merge_approval_decisions DISABLE TRIGGER merge_approval_decisions_integrity_trigger",
    );
    try {
      await expect(assertMergeApprovalIntegrity(getPool())).rejects.toThrow(
        "merge_approval_decisions_integrity_trigger is disabled",
      );
    } finally {
      await q(
        "ALTER TABLE merge_approval_decisions ENABLE TRIGGER merge_approval_decisions_integrity_trigger",
      );
    }
    await q(
      `CREATE OR REPLACE FUNCTION merge_approval_refuse_truncate() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$`,
    );
    await expect(
      mergeApprovalIntegritySchemaNeedsSync(getPool()),
    ).resolves.toBe(true);
    await expect(assertMergeApprovalIntegrity(getPool())).rejects.toThrow(
      "is outdated",
    );
    const client = await getPool().connect();
    try {
      await ensureMergeApprovalIntegritySchema(client);
    } finally {
      client.release();
    }
    await expect(assertMergeApprovalIntegrity(getPool())).resolves.toBe(
      undefined,
    );
  });

  it("let only the test reset truncate them, and stay in force after it", async () => {
    await insertRequest();
    await truncateTablesForTestReset(getPool(), [
      "merge_approval_relays",
      "merge_approval_decisions",
      "merge_approval_requests",
    ]);
    const { rows } = await q(
      "SELECT count(*)::int AS n FROM merge_approval_requests",
    );
    expect(rows[0].n).toBe(0);
    await expect(assertMergeApprovalIntegrity(getPool())).resolves.toBe(
      undefined,
    );
    await expect(q("TRUNCATE merge_approval_requests CASCADE")).rejects.toThrow(
      "cannot be truncated",
    );
  });
});
