/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { after, before, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  attestReleasedLroDedupeSuccesses,
  claimLroOps,
  createLro,
  ensureLroSchema,
  expireDueLros,
  getLro,
  listLrosByDedupe,
  mergeLroResult,
  updateLro,
} from "./lro-db";

beforeAll(async () => {
  await before();
}, 15_000);
afterAll(after);

describe("LRO database maintenance integration", () => {
  it("defers scheduled jobs, preserves dedupe, and excludes canceled jobs", async () => {
    const kind = `scheduled-collection-test-${uuid()}`;
    const scope_id = uuid();
    const run_at = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const args = {
      kind,
      scope_type: "project" as const,
      scope_id,
      input: { run_at: run_at.toISOString() },
      expires_at: new Date(run_at.getTime() + 7 * 24 * 60 * 60 * 1000),
      dedupe_key: `scheduled:${uuid()}`,
    };
    const scheduled = await createLro(args);
    const duplicate = await createLro(args);
    expect(duplicate.op_id).toBe(scheduled.op_id);
    const canceled = await createLro({
      ...args,
      dedupe_key: `canceled:${uuid()}`,
    });
    await updateLro({ op_id: canceled.op_id, status: "canceled" });
    const claim = {
      kind,
      owner_type: "hub" as const,
      owner_id: uuid(),
      input_not_before_key: "run_at",
    };
    await expect(expireDueLros({ kind })).resolves.toHaveLength(0);
    await expect(claimLroOps(claim)).resolves.toHaveLength(0);
    // Advance only the synthetic jobs' due times; cancellation must still win.
    await getPool().query(
      `UPDATE long_running_operations
          SET input=jsonb_set(input, '{run_at}', to_jsonb((NOW() - interval '1 second')::text))
        WHERE op_id=ANY($1::uuid[])`,
      [[scheduled.op_id, canceled.op_id]],
    );
    await expect(claimLroOps(claim)).resolves.toEqual([
      expect.objectContaining({ op_id: scheduled.op_id, status: "running" }),
    ]);
    await expect(getLro(canceled.op_id)).resolves.toMatchObject({
      status: "canceled",
    });
  });

  it("expires only bounded due active rows", async () => {
    const kind = `expiration-test-${uuid()}`;
    const scope_id = uuid();
    const first = await createLro({
      kind,
      scope_type: "project",
      scope_id,
      expires_at: new Date(Date.now() - 60_000),
    });
    const second = await createLro({
      kind,
      scope_type: "project",
      scope_id,
      expires_at: new Date(Date.now() - 30_000),
    });
    const future = await createLro({
      kind,
      scope_type: "project",
      scope_id,
      expires_at: new Date(Date.now() + 60_000),
    });

    await expect(expireDueLros({ kind, limit: 1 })).resolves.toHaveLength(1);
    await expect(expireDueLros({ kind, limit: 1 })).resolves.toHaveLength(1);
    await expect(expireDueLros({ kind, limit: 1 })).resolves.toHaveLength(0);
    await expect(getLro(first.op_id)).resolves.toMatchObject({
      status: "expired",
    });
    await expect(getLro(second.op_id)).resolves.toMatchObject({
      status: "expired",
    });
    await expect(getLro(future.op_id)).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("installs the partial expiration index", async () => {
    await ensureLroSchema();
    const { rows } = await getPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname='lro_expiry_idx'`,
    );
    expect(rows[0]?.indexdef).toContain("expires_at");
    expect(rows[0]?.indexdef).toContain("dismissed_at IS NULL");
  });

  it("lists all operations for a durable dedupe identity newest first", async () => {
    const scope_id = uuid();
    const dedupe_key = `archive-final:${uuid()}`;
    const first = await createLro({
      kind: "project-backup",
      scope_type: "project",
      scope_id,
      dedupe_key,
    });
    await updateLro({
      op_id: first.op_id,
      status: "succeeded",
      result: { id: "backup-1", generation: 1 },
    });
    await getPool().query(
      `UPDATE long_running_operations
          SET created_at = created_at - interval '1 minute'
        WHERE op_id=$1`,
      [first.op_id],
    );
    const second = await createLro({
      kind: "project-backup",
      scope_type: "project",
      scope_id,
      dedupe_key,
    });

    await expect(
      listLrosByDedupe({
        scope_type: "project",
        scope_id,
        dedupe_key,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ op_id: second.op_id, status: "queued" }),
      expect.objectContaining({ op_id: first.op_id, status: "succeeded" }),
    ]);
  });

  it("attests every successful operation released under the dedupe lock", async () => {
    const scope_id = uuid();
    const dedupe_key = `archive-release:${uuid()}`;
    const succeeded = await createLro({
      kind: "project-backup",
      scope_type: "project",
      scope_id,
      dedupe_key,
    });
    await updateLro({
      op_id: succeeded.op_id,
      status: "succeeded",
      result: { id: "backup-release", generation: 17 },
    });
    const uncertain = await createLro({
      kind: "project-backup",
      scope_type: "project",
      scope_id,
      dedupe_key,
    });
    await updateLro({
      op_id: uncertain.op_id,
      status: "failed",
      result: { archive_freeze_recovery: "uncertain" },
    });

    await expect(
      attestReleasedLroDedupeSuccesses({
        scope_type: "project",
        scope_id,
        dedupe_key,
        expected_result_id: "backup-release",
        expected_generation: 18,
      }),
    ).rejects.toThrow("does not match the final backup");
    await expect(getLro(succeeded.op_id)).resolves.toMatchObject({
      result: { id: "backup-release", generation: 17 },
    });

    await expect(
      attestReleasedLroDedupeSuccesses({
        scope_type: "project",
        scope_id,
        dedupe_key,
        expected_result_id: "backup-release",
        expected_generation: 17,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op_id: succeeded.op_id }),
        expect.objectContaining({ op_id: uncertain.op_id }),
      ]),
    );
    await expect(getLro(succeeded.op_id)).resolves.toMatchObject({
      status: "succeeded",
      result: {
        id: "backup-release",
        generation: 17,
        archive_freeze_recovery: "released",
      },
    });
  });

  it("merges a terminal LRO result without discarding prior evidence", async () => {
    const op = await createLro({
      kind: "project-backup",
      scope_type: "project",
      scope_id: uuid(),
    });
    await updateLro({
      op_id: op.op_id,
      status: "failed",
      result: {
        backup_id: "backup-late",
        archive_freeze_recovery: "uncertain",
      },
    });

    await expect(
      mergeLroResult({
        op_id: op.op_id,
        result: { archive_freeze_recovery: "released" },
        if_status: ["failed"],
      }),
    ).resolves.toMatchObject({
      status: "failed",
      result: {
        backup_id: "backup-late",
        archive_freeze_recovery: "released",
      },
    });
  });
});
