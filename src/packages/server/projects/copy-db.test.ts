export {};

import { before, after, getPool } from "@cocalc/server/test";

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: jest.fn(async () => ({
    deleteBackup: jest.fn(async () => undefined),
  })),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroSummary: jest.fn(async () => undefined),
}));

const HOST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SRC_PROJECT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEST_PROJECT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

beforeEach(async () => {
  const { ensureCopySchema } = await import("./copy-db");
  const { ensureLroSchema } = await import("@cocalc/server/lro/lro-db");
  await ensureCopySchema();
  await ensureLroSchema();
  const pool = getPool();
  await pool.query("DELETE FROM project_copies");
  await pool.query("DELETE FROM long_running_operations");
  await pool.query("DELETE FROM projects WHERE project_id = ANY($1::uuid[])", [
    [SRC_PROJECT_ID, DEST_PROJECT_ID],
  ]);
  await pool.query(
    "INSERT INTO projects (project_id, host_id) VALUES ($1, $2), ($3, $2)",
    [SRC_PROJECT_ID, HOST_ID, DEST_PROJECT_ID],
  );
});

describe("projects.copy-db", () => {
  it("serializes conflicting destination writes instead of orphaning later ops", async () => {
    const {
      claimPendingCopies,
      ensureCopySchema,
      updateCopyStatus,
      upsertCopyRow,
    } = await import("./copy-db");
    await ensureCopySchema();

    const first = await upsertCopyRow({
      op_id: "11111111-1111-4111-8111-111111111111",
      src_project_id: SRC_PROJECT_ID,
      src_path: "a.txt",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "/root/a.txt",
      snapshot_id: "snap-1",
      expires_at: new Date(Date.now() + 60_000),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await upsertCopyRow({
      op_id: "22222222-2222-4222-8222-222222222222",
      src_project_id: SRC_PROJECT_ID,
      src_path: "a.txt",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "/root/a.txt",
      snapshot_id: "snap-2",
      expires_at: new Date(Date.now() + 60_000),
    });

    expect(first.copy_id).not.toBe(second.copy_id);

    const claimed1 = await claimPendingCopies({ host_id: HOST_ID, limit: 10 });
    expect(claimed1).toHaveLength(1);
    expect(claimed1[0].copy_id).toBe(first.copy_id);
    expect(claimed1[0].snapshot_id).toBe("snap-1");

    let rows = await getPool().query<{
      copy_id: string;
      status: string;
      snapshot_id: string;
    }>(
      `
        SELECT copy_id, status, snapshot_id
        FROM project_copies
        ORDER BY created_at
      `,
    );
    expect(rows.rows).toEqual([
      { copy_id: first.copy_id, status: "applying", snapshot_id: "snap-1" },
      { copy_id: second.copy_id, status: "queued", snapshot_id: "snap-2" },
    ]);

    const key = {
      src_project_id: SRC_PROJECT_ID,
      src_path: "a.txt",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "/root/a.txt",
    };
    await updateCopyStatus({
      copy_id: first.copy_id,
      key,
      status: "done",
    });

    const claimed2 = await claimPendingCopies({ host_id: HOST_ID, limit: 10 });
    expect(claimed2).toHaveLength(1);
    expect(claimed2[0].copy_id).toBe(second.copy_id);
    expect(claimed2[0].snapshot_id).toBe("snap-2");

    await updateCopyStatus({
      key,
      status: "done",
    });

    rows = await getPool().query<{
      copy_id: string;
      status: string;
      snapshot_id: string;
    }>(
      `
        SELECT copy_id, status, snapshot_id
        FROM project_copies
        ORDER BY created_at
      `,
    );
    expect(rows.rows).toEqual([
      { copy_id: first.copy_id, status: "done", snapshot_id: "snap-1" },
      { copy_id: second.copy_id, status: "done", snapshot_id: "snap-2" },
    ]);
  });

  it("keeps retries for the same op idempotent", async () => {
    const { ensureCopySchema, insertCopyRowIfMissing, listCopiesByOpId } =
      await import("./copy-db");
    await ensureCopySchema();

    const row = {
      op_id: "33333333-3333-4333-8333-333333333333",
      src_project_id: SRC_PROJECT_ID,
      src_path: "a.txt",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "/root/a.txt",
      snapshot_id: "snap-3",
      expires_at: new Date(Date.now() + 60_000),
    };
    const inserted = await insertCopyRowIfMissing(row);
    const duplicate = await insertCopyRowIfMissing(row);

    expect(inserted?.copy_id).toBeDefined();
    expect(duplicate).toBeUndefined();

    const listed = await listCopiesByOpId({ op_id: row.op_id });
    expect(listed).toHaveLength(1);
    expect(listed[0].snapshot_id).toBe("snap-3");
  });

  it("reclaims stale applying copies before later conflicting copies", async () => {
    const { claimPendingCopies, ensureCopySchema, upsertCopyRow } =
      await import("./copy-db");
    await ensureCopySchema();

    const first = await upsertCopyRow({
      op_id: "44444444-4444-4444-8444-444444444444",
      src_project_id: SRC_PROJECT_ID,
      src_path: "a.txt",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "/root/a.txt",
      snapshot_id: "snap-4",
      expires_at: new Date(Date.now() + 60_000),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await upsertCopyRow({
      op_id: "55555555-5555-4555-8555-555555555555",
      src_project_id: SRC_PROJECT_ID,
      src_path: "a.txt",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "/root/a.txt",
      snapshot_id: "snap-5",
      expires_at: new Date(Date.now() + 60_000),
    });

    const claimed1 = await claimPendingCopies({ host_id: HOST_ID, limit: 10 });
    expect(claimed1).toHaveLength(1);
    expect(claimed1[0].copy_id).toBe(first.copy_id);

    await getPool().query(
      `
        UPDATE project_copies
        SET last_attempt_at = now() - interval '36 minutes',
            updated_at = now() - interval '36 minutes',
            last_error = 'previous failure'
        WHERE copy_id=$1
      `,
      [first.copy_id],
    );

    const claimed2 = await claimPendingCopies({ host_id: HOST_ID, limit: 10 });
    expect(claimed2).toHaveLength(1);
    expect(claimed2[0].copy_id).toBe(first.copy_id);

    const rows = await getPool().query<{
      copy_id: string;
      status: string;
      attempt: number;
      last_error: string | null;
    }>(
      `
        SELECT copy_id, status, attempt, last_error
        FROM project_copies
        ORDER BY created_at
      `,
    );
    expect(rows.rows).toEqual([
      {
        copy_id: first.copy_id,
        status: "applying",
        attempt: 2,
        last_error: null,
      },
      {
        copy_id: second.copy_id,
        status: "queued",
        attempt: 0,
        last_error: null,
      },
    ]);
  });

  it("does not move terminal copy LROs back to running", async () => {
    const { ensureLroSchema } = await import("@cocalc/server/lro/lro-db");
    const { ensureCopySchema, updateCopyStatus, upsertCopyRow } =
      await import("./copy-db");
    await ensureLroSchema();
    await ensureCopySchema();
    const op_id = "66666666-6666-4666-8666-666666666666";
    await getPool().query(
      `
        INSERT INTO long_running_operations
          (op_id, kind, scope_type, scope_id, status, input, result, progress_summary, finished_at, expires_at)
        VALUES
          ($1, 'copy-path-between-projects', 'project', $2, 'succeeded', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now() + interval '1 hour')
      `,
      [op_id, SRC_PROJECT_ID],
    );

    const row = await upsertCopyRow({
      op_id,
      src_project_id: SRC_PROJECT_ID,
      src_path: "a.txt",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "/root/a.txt",
      snapshot_id: "snap-6",
      expires_at: new Date(Date.now() + 60_000),
    });

    await updateCopyStatus({
      copy_id: row.copy_id,
      key: {
        src_project_id: SRC_PROJECT_ID,
        src_path: "a.txt",
        dest_project_id: DEST_PROJECT_ID,
        dest_path: "/root/a.txt",
      },
      status: "failed",
      last_error: "copy failed later",
    });

    const { rows } = await getPool().query<{
      status: string;
      finished_at: Date | null;
    }>(
      "SELECT status, finished_at FROM long_running_operations WHERE op_id=$1",
      [op_id],
    );
    expect(rows[0]).toEqual({
      status: "succeeded",
      finished_at: expect.any(Date),
    });
  });
});
