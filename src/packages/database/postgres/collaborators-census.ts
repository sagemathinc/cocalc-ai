/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { validateDiscoveryReport } from "@cocalc/util/collaboration-census";
import type {
  CollaborationDiscoveryState,
  CollaborationDiscoveryWrite,
} from "@cocalc/util/collaboration-census";
import { transaction, uuid } from "./collaborators-common";
import {
  assertCollaborationAccountAuthority,
  assertCollaborationWriterAuthority,
} from "./collaborators-owner";
import type {
  CollaborationOwnerAuthority,
  CollaborationWriterAuthority,
} from "./collaborators-owner";

export async function collaborationDiscoveryForHost(
  project_id: string,
  authority: CollaborationWriterAuthority,
): Promise<{ run_id: string | null }> {
  return transaction(async (db) => {
    await assertCollaborationWriterAuthority(db, project_id, authority);
    const row = (
      await db.query(
        "SELECT run_id FROM collaboration_discovery WHERE project_id=$1",
        [project_id],
      )
    ).rows[0];
    return { run_id: row?.run_id ?? null };
  });
}

export async function reportCollaborationDiscovery(
  input: CollaborationDiscoveryWrite,
  authority: CollaborationWriterAuthority,
): Promise<{ replayed: boolean }> {
  uuid(input.project_id, "project_id");
  if (input.expected_run_id !== null)
    uuid(input.expected_run_id, "expected_run_id");
  const report = validateDiscoveryReport(input.report);
  return transaction(async (db) => {
    await assertCollaborationWriterAuthority(db, input.project_id, authority);
    const row = (
      await db.query(
        "SELECT * FROM collaboration_discovery WHERE project_id=$1 FOR UPDATE",
        [input.project_id],
      )
    ).rows[0];
    if (row?.run_id === report.run_id) {
      if (row.writer_host_id !== authority.host_id)
        throw Error("stale discovery writer");
      if (Number(row.sequence) > report.sequence)
        throw Error("stale discovery sequence");
      if (Number(row.sequence) === report.sequence) {
        if (
          JSON.stringify(validateDiscoveryReport(row.report)) !==
          JSON.stringify(report)
        )
          throw Error("discovery sequence reused with different report");
        return { replayed: true };
      }
    } else if ((row?.run_id ?? null) !== input.expected_run_id) {
      throw Error("stale discovery run");
    }
    await db.query(
      `INSERT INTO collaboration_discovery(project_id,writer_host_id,run_id,sequence,report,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,now()) ON CONFLICT(project_id) DO UPDATE SET writer_host_id=excluded.writer_host_id,
      run_id=excluded.run_id,sequence=excluded.sequence,report=excluded.report,updated_at=excluded.updated_at`,
      [
        input.project_id,
        authority.host_id,
        report.run_id,
        report.sequence,
        JSON.stringify(report),
      ],
    );
    return { replayed: false };
  });
}

export async function getCollaborationDiscovery(
  input: { account_id: string; project_id: string },
  authority: CollaborationOwnerAuthority,
): Promise<CollaborationDiscoveryState> {
  uuid(input.account_id, "account_id");
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      input.project_id,
      input.account_id,
      authority,
    );
    const row = (
      await db.query(
        `SELECT d.report,d.updated_at,d.writer_host_id=p.host_id AS current,
      d.updated_at>now()-interval '30 minutes' AS fresh FROM collaboration_discovery d
      JOIN projects p USING(project_id) WHERE d.project_id=$1`,
        [input.project_id],
      )
    ).rows[0];
    if (!row) return { status: "pending" };
    if (!row.current) return { status: "unavailable" };
    const report = validateDiscoveryReport(row.report);
    return {
      status: row.fresh ? report.coverage : "unavailable",
      report,
      updated_at: new Date(row.updated_at).getTime(),
    };
  });
}
