/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Database invariants of project funding (PROJECT_FUNDING.md), against a
// real (PGlite) database.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const FUNDER = "00000000-1000-4000-8000-000000000001";

async function enqueue(
  approval_id: string,
  target: "project" | "funder",
  kind: string,
  version: number,
): Promise<void> {
  await getPool().query(
    `INSERT INTO project_funding_outbox
       (id, approval_id, project_id, target, funder_account_id, kind, version, payload, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', now())`,
    [randomUUID(), approval_id, randomUUID(), target, FUNDER, kind, version],
  );
}

describeDb("project funding outbox identities", () => {
  beforeAll(async () => {
    await syncSchema({
      project_funding_outbox: SCHEMA.project_funding_outbox,
      project_compute_approvals: SCHEMA.project_compute_approvals,
    });
  });

  it("lets each direction send its own end at the same approval version", async () => {
    const a = randomUUID();
    await enqueue(a, "project", "end", 3);
    await expect(enqueue(a, "funder", "end", 3)).resolves.toBeUndefined();
  });

  it("refuses two different approval-state messages at one version in one direction", async () => {
    const a = randomUUID();
    await enqueue(a, "project", "update", 3);
    await expect(enqueue(a, "project", "end", 3)).rejects.toThrow(/unique/i);
  });

  it("numbers pod counts separately from approval versions", async () => {
    const a = randomUUID();
    await enqueue(a, "project", "update", 3);
    await expect(enqueue(a, "project", "pods", 3)).resolves.toBeUndefined();
    await expect(enqueue(a, "project", "pods", 3)).rejects.toThrow(/unique/i);
  });

  it("keeps one pending request and one nonterminal approval per project", async () => {
    const project_id = randomUUID();
    const insert = (kind: string, state: string) =>
      getPool().query(
        `INSERT INTO project_compute_approvals
           (id, kind, project_id, provider, state, approval_id, funder_account_id,
            funder_bay_id, version, lease_expires_at, layer_id)
         VALUES ($1, $2, $3, 'runpod', $4, $5, $6, $7, 1, $8, $9)`,
        kind === "request"
          ? [
              randomUUID(),
              kind,
              project_id,
              state,
              null,
              null,
              null,
              null,
              null,
            ]
          : [
              randomUUID(),
              kind,
              project_id,
              state,
              randomUUID(),
              FUNDER,
              "bay-h",
              state === "pending" ? new Date() : null,
              state === "active" ? randomUUID() : null,
            ],
      );
    await insert("request", "pending");
    await insert("approval", "pending");
    await expect(insert("request", "pending")).rejects.toThrow(/unique/i);
    await expect(insert("approval", "active")).rejects.toThrow(/unique/i);
  });
});
