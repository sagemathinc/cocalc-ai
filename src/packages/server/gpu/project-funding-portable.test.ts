/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Project rehome of project funding rows (PROJECT_FUNDING.md §4a), against a
// real (PGlite) database: the old owner's read, the new owner's version-aware
// merge.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  mergeProjectComputeApprovals,
  readProjectComputeApprovals,
} from "./project-funding-portable";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const FUNDER = "00000000-1000-4000-8000-000000000001";
const DISPLAY = {
  authorized_usd: "400",
  ends_at: "2026-11-08T12:00:00.000Z",
  agents_allowed: true,
};

async function insertApproval(
  project_id: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const approval_id = randomUUID();
  const row = {
    id: randomUUID(),
    kind: "approval",
    project_id,
    provider: "runpod",
    state: "active",
    approval_id,
    funder_account_id: FUNDER,
    funder_bay_id: "bay-h",
    layer_id: randomUUID(),
    version: 2,
    live_pods: 0,
    pods_version: 0,
    display: JSON.stringify(DISPLAY),
    ...over,
  };
  const cols = Object.keys(row);
  await getPool().query(
    `INSERT INTO project_compute_approvals (${cols.join(",")}) VALUES (${cols
      .map((_, i) => `$${i + 1}`)
      .join(",")})`,
    Object.values(row),
  );
  return approval_id;
}

async function insertRequest(
  project_id: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO project_compute_approvals (id, kind, project_id, provider, state, actor_kind, request_summary, updated)
     VALUES ($1, 'request', $2, 'runpod', $3, 'project', $4, $5)`,
    [
      id,
      project_id,
      over.state ?? "pending",
      JSON.stringify({ gpu_type_id: "RTX 4090" }),
      over.updated ?? new Date(),
    ],
  );
  return id;
}

async function wipe(project_id: string) {
  await getPool().query(
    "DELETE FROM project_compute_approvals WHERE project_id = $1",
    [project_id],
  );
}

describeDb("project funding rows in project rehome", () => {
  beforeAll(async () => {
    await syncSchema({
      project_compute_approvals: SCHEMA.project_compute_approvals,
    });
  });

  it("copies every row to a bay that has none, exactly", async () => {
    const project_id = randomUUID();
    await insertApproval(project_id, { live_pods: 1, pods_version: 3 });
    await insertRequest(project_id, { state: "approved" });
    const copied = await readProjectComputeApprovals(project_id);
    expect(copied).toHaveLength(2);
    await wipe(project_id);
    expect(
      await mergeProjectComputeApprovals({ project_id, rows: copied }),
    ).toBe(2);
    expect(await readProjectComputeApprovals(project_id)).toEqual(copied);
  });

  it("is idempotent: merging the same rows again changes nothing", async () => {
    const project_id = randomUUID();
    await insertApproval(project_id);
    const copied = await readProjectComputeApprovals(project_id);
    expect(
      await mergeProjectComputeApprovals({ project_id, rows: copied }),
    ).toBe(0);
  });

  it("keeps the newer approval version here and takes the newer locator from the copy", async () => {
    const project_id = randomUUID();
    const approval_id = await insertApproval(project_id, {
      version: 2,
      live_pods: 2,
      pods_version: 5,
    });
    const copied = await readProjectComputeApprovals(project_id);
    // this bay already applied a later end, but an older locator
    await getPool().query(
      `UPDATE project_compute_approvals
          SET state = 'ended', version = 3, ended_reason = 'revoked', ended_at = now(),
              live_pods = 0, pods_version = 4
        WHERE approval_id = $1`,
      [approval_id],
    );
    expect(
      await mergeProjectComputeApprovals({ project_id, rows: copied }),
    ).toBe(1);
    const [row] = await readProjectComputeApprovals(project_id);
    expect(row).toMatchObject({
      state: "ended",
      version: 3,
      ended_reason: "revoked",
      live_pods: 2,
      pods_version: 5,
    });
  });

  it("never lets a copied older active route resurrect an ended one", async () => {
    const project_id = randomUUID();
    const approval_id = await insertApproval(project_id, { version: 2 });
    const copied = await readProjectComputeApprovals(project_id);
    await getPool().query(
      `UPDATE project_compute_approvals
          SET state = 'ended', version = 3, ended_reason = 'expired', ended_at = now()
        WHERE approval_id = $1`,
      [approval_id],
    );
    await mergeProjectComputeApprovals({ project_id, rows: copied });
    const [row] = await readProjectComputeApprovals(project_id);
    expect(row.state).toBe("ended");
  });

  it("keeps one pending request per project: the newer one wins", async () => {
    const project_id = randomUUID();
    const older = await insertRequest(project_id, {
      updated: new Date("2026-11-01T00:00:00Z"),
    });
    const copied = await readProjectComputeApprovals(project_id);
    await wipe(project_id);
    const newer = await insertRequest(project_id, {
      updated: new Date("2026-11-02T00:00:00Z"),
    });
    await mergeProjectComputeApprovals({ project_id, rows: copied });
    const rows = await readProjectComputeApprovals(project_id);
    const state = Object.fromEntries(rows.map((r) => [r.id, r.state]));
    expect(state).toEqual({ [older]: "superseded", [newer]: "pending" });
  });

  it("ignores rows of another project", async () => {
    const project_id = randomUUID();
    const other = randomUUID();
    await insertApproval(other);
    const copied = await readProjectComputeApprovals(other);
    expect(
      await mergeProjectComputeApprovals({ project_id, rows: copied }),
    ).toBe(0);
  });
});
