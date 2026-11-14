export {};

import { before, after, getPool } from "@cocalc/server/test";

jest.setTimeout(15000);

const mockDeleteBackup = jest.fn(async (_opts: any) => undefined);

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: jest.fn(async () => ({
    deleteBackup: (opts: any) => mockDeleteBackup(opts),
  })),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroSummary: jest.fn(async () => undefined),
}));

const HOST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SRC_PROJECT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEST_PROJECT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_SRC_PROJECT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

async function ensureLroTableForCopyDbTest(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS long_running_operations (
      op_id UUID PRIMARY KEY,
      kind TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id UUID NOT NULL,
      status TEXT NOT NULL,
      created_by UUID,
      owner_type TEXT,
      owner_id UUID,
      routing TEXT,
      input JSONB DEFAULT '{}'::jsonb,
      result JSONB DEFAULT '{}'::jsonb,
      error TEXT,
      progress_summary JSONB DEFAULT '{}'::jsonb,
      attempt INTEGER DEFAULT 0,
      heartbeat_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      dismissed_at TIMESTAMPTZ,
      dismissed_by UUID,
      updated_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      dedupe_key TEXT,
      parent_id UUID
    )
  `);
}

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

// Leak check, real PostgreSQL only.  Phase A, while the pool is open: no
// client is still checked out, every other session belongs to the code's
// pool (test observers and holders are pool clients, released by now), and
// no advisory lock is held anywhere (a skipped unlock on a returned client
// would vanish once the pool closes).
// Phase B, after the normal teardown: no client backend is left in any
// database.  Both use one connection outside the code's pool.
afterAll(async () => {
  if (
    process.env.COCALC_TEST_USE_PGLITE ||
    process.env.COCALC_DB === "pglite"
  ) {
    process.stdout.write("afterAll leak check: n/a (PGlite)\n");
    await after();
    return;
  }
  const { Client } = await import("pg");
  const verifier = new Client({ database: "smc" });
  await verifier.connect();
  try {
    await leakCheck(verifier);
  } finally {
    await verifier.end();
  }
});

async function leakCheck(verifier: {
  query: (sql: string) => Promise<{ rows: any[] }>;
}): Promise<void> {
  const count = async (sql: string) =>
    Number((await verifier.query(sql)).rows[0]?.n ?? -1);
  const backends = () =>
    count(
      "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()",
    );
  const advisoryLocks = () =>
    count(
      "SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid <> pg_backend_pid()",
    );
  const pool = getPool() as any;
  const poolTotal = pool.totalCount;
  const checkedOut = poolTotal - pool.idleCount;
  const waiting = pool.waitingCount;
  const otherBackends = await backends();
  const locksA = await advisoryLocks();
  process.stdout.write(
    `afterAll leak check A (pool open): checked_out=${checkedOut} waiting=${waiting} other_client_backends=${otherBackends} pool_total=${poolTotal} advisory_locks=${locksA}\n`,
  );
  // Fail here rather than wait for a pool that can't close.
  expect({
    checkedOut,
    waiting,
    outsidePool: otherBackends - poolTotal,
    locksA,
  }).toEqual({
    checkedOut: 0,
    waiting: 0,
    outsidePool: 0,
    locksA: 0,
  });
  await after();
  let backendsB = await backends();
  let locksB = await advisoryLocks();
  for (let i = 0; i < 50 && (backendsB !== 0 || locksB !== 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    backendsB = await backends();
    locksB = await advisoryLocks();
  }
  process.stdout.write(
    `afterAll leak check B (pool closed): client_backends=${backendsB} advisory_locks=${locksB}\n`,
  );
  expect({ backendsB, locksB }).toEqual({ backendsB: 0, locksB: 0 });
}

beforeEach(async () => {
  const { ensureCopySchema } = await import("./copy-db");
  const { ensureLroSchema } = await import("@cocalc/server/lro/lro-db");
  await ensureCopySchema();
  await ensureLroSchema();
  await ensureLroTableForCopyDbTest();
  const pool = getPool();
  await pool.query("DELETE FROM project_copies");
  await pool.query("DELETE FROM project_copy_snapshot_claims");
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
      snapshot_created: false,
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
      snapshot_created: false,
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
      snapshot_created: false,
      exact: true,
      expires_at: new Date(Date.now() + 60_000),
    };
    const inserted = await insertCopyRowIfMissing(row);
    const duplicate = await insertCopyRowIfMissing(row);

    expect(inserted?.copy_id).toBeDefined();
    expect(duplicate).toBeUndefined();

    const listed = await listCopiesByOpId({ op_id: row.op_id });
    expect(listed).toHaveLength(1);
    expect(listed[0].snapshot_id).toBe("snap-3");
    expect(listed[0].exact).toBe(true);
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
      snapshot_created: false,
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
      snapshot_created: false,
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
      snapshot_created: false,
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

    const rows = await getPool().query<{
      status: string;
      finished_at: Date | null;
    }>(
      "SELECT status, finished_at FROM long_running_operations WHERE op_id=$1",
      [op_id],
    );
    expect(rows.rows[0]).toEqual({
      status: "succeeded",
      finished_at: expect.any(Date),
    });
  });

  it("preserves source audit metadata when queued copies finish", async () => {
    const { ensureLroSchema } = await import("@cocalc/server/lro/lro-db");
    const { ensureCopySchema, updateCopyStatus, upsertCopyRow } =
      await import("./copy-db");
    await ensureLroSchema();
    await ensureCopySchema();
    const op_id = "99999999-9999-4999-8999-999999999999";
    const source_versions = [
      {
        path: "assignment/work.ipynb",
        version: "version-1",
        sha256: "sha256",
      },
    ];
    await getPool().query(
      `
        INSERT INTO long_running_operations
          (op_id, kind, scope_type, scope_id, status, input, result, progress_summary, expires_at)
        VALUES
          ($1, 'copy-path-between-projects', 'project', $2, 'running', '{}'::jsonb, $3::jsonb, '{}'::jsonb, now() + interval '1 hour')
      `,
      [op_id, SRC_PROJECT_ID, JSON.stringify({ source_versions })],
    );
    const row = await upsertCopyRow({
      op_id,
      src_project_id: SRC_PROJECT_ID,
      src_path: "assignment/work.ipynb",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "collected/work.ipynb",
      snapshot_id: "snap-audit",
      snapshot_created: false,
      expires_at: new Date(Date.now() + 60_000),
    });

    await updateCopyStatus({
      copy_id: row.copy_id,
      key: {
        src_project_id: SRC_PROJECT_ID,
        src_path: "assignment/work.ipynb",
        dest_project_id: DEST_PROJECT_ID,
        dest_path: "collected/work.ipynb",
      },
      status: "done",
    });

    const { rows } = await getPool().query<{
      status: string;
      result: Record<string, any>;
    }>("SELECT status, result FROM long_running_operations WHERE op_id=$1", [
      op_id,
    ]);
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].result).toEqual(
      expect.objectContaining({ source_versions, done: 1, total: 1 }),
    );
  });

  it("does not let terminal parent LRO copy rows block later copies", async () => {
    const { ensureLroSchema } = await import("@cocalc/server/lro/lro-db");
    const { claimPendingCopies, ensureCopySchema, upsertCopyRow } =
      await import("./copy-db");
    await ensureLroSchema();
    await ensureCopySchema();

    const canceledOp = "77777777-7777-4777-8777-777777777777";
    await getPool().query(
      `
        INSERT INTO long_running_operations
          (op_id, kind, scope_type, scope_id, status, input, result, progress_summary, finished_at, expires_at)
        VALUES
          ($1, 'copy-path-between-projects', 'project', $2, 'canceled', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now() + interval '1 hour')
      `,
      [canceledOp, SRC_PROJECT_ID],
    );
    const blocker = await upsertCopyRow({
      op_id: canceledOp,
      src_project_id: SRC_PROJECT_ID,
      src_path: "a.txt",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "/root/a.txt",
      snapshot_id: "snap-7",
      snapshot_created: false,
      expires_at: new Date(Date.now() + 60_000),
    });
    await getPool().query(
      "UPDATE project_copies SET status='applying', last_attempt_at=now(), updated_at=now() WHERE copy_id=$1",
      [blocker.copy_id],
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await upsertCopyRow({
      op_id: "88888888-8888-4888-8888-888888888888",
      src_project_id: SRC_PROJECT_ID,
      src_path: "a.txt",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "/root/a.txt",
      snapshot_id: "snap-8",
      snapshot_created: false,
      expires_at: new Date(Date.now() + 60_000),
    });

    const claimed = await claimPendingCopies({ host_id: HOST_ID, limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].copy_id).toBe(next.copy_id);

    const rows = await getPool().query<{
      copy_id: string;
      status: string;
      last_error: string | null;
    }>(
      `
        SELECT copy_id, status, last_error
        FROM project_copies
        ORDER BY created_at
      `,
    );
    expect(rows.rows).toEqual([
      {
        copy_id: blocker.copy_id,
        status: "canceled",
        last_error: "parent operation canceled",
      },
      {
        copy_id: next.copy_id,
        status: "applying",
        last_error: null,
      },
    ]);
  });

  it("does not retry failed copy rows or let them block later copies", async () => {
    const {
      claimPendingCopies,
      ensureCopySchema,
      updateCopyStatus,
      upsertCopyRow,
    } = await import("./copy-db");
    await ensureCopySchema();

    const failed = await upsertCopyRow({
      op_id: "99999999-9999-4999-8999-999999999999",
      src_project_id: SRC_PROJECT_ID,
      src_path: "cowasm",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "cowasm",
      snapshot_id: "snap-failed",
      snapshot_created: false,
      expires_at: new Date(Date.now() + 60_000),
    });

    await updateCopyStatus({
      copy_id: failed.copy_id,
      key: {
        src_project_id: SRC_PROJECT_ID,
        src_path: "cowasm",
        dest_project_id: DEST_PROJECT_ID,
        dest_path: "cowasm",
      },
      status: "failed",
      last_error: "permission denied",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await upsertCopyRow({
      op_id: "aaaaaaaa-9999-4999-8999-999999999999",
      src_project_id: SRC_PROJECT_ID,
      src_path: "cowasm",
      dest_project_id: DEST_PROJECT_ID,
      dest_path: "cowasm",
      snapshot_id: "snap-next",
      snapshot_created: false,
      expires_at: new Date(Date.now() + 60_000),
    });

    const claimed = await claimPendingCopies({ host_id: HOST_ID, limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].copy_id).toBe(next.copy_id);
    expect(claimed[0].snapshot_id).toBe("snap-next");

    const rows = await getPool().query<{
      copy_id: string;
      status: string;
      snapshot_id: string;
      last_error: string | null;
    }>(
      `
        SELECT copy_id, status, snapshot_id, last_error
        FROM project_copies
        ORDER BY created_at
      `,
    );
    expect(rows.rows).toEqual([
      {
        copy_id: failed.copy_id,
        status: "failed",
        snapshot_id: "snap-failed",
        last_error: "permission denied",
      },
      {
        copy_id: next.copy_id,
        status: "applying",
        snapshot_id: "snap-next",
        last_error: null,
      },
    ]);
  });
});

describe("projects.copy-db snapshot cleanup", () => {
  const key = (dest_path: string) => ({
    src_project_id: SRC_PROJECT_ID,
    src_path: "a.txt",
    dest_project_id: DEST_PROJECT_ID,
    dest_path,
  });
  async function queue({
    dest_path = "/root/a.txt",
    snapshot_id = "snap-x",
    snapshot_created,
    op_id,
    expires_at = new Date(Date.now() + 60_000),
    src_project_id = SRC_PROJECT_ID,
  }: {
    dest_path?: string;
    snapshot_id?: string;
    snapshot_created: boolean;
    op_id?: string;
    expires_at?: Date;
    src_project_id?: string;
  }) {
    const { upsertCopyRow } = await import("./copy-db");
    return await upsertCopyRow({
      ...key(dest_path),
      src_project_id,
      op_id,
      snapshot_id,
      snapshot_created,
      expires_at,
    });
  }
  async function finish(
    copy_id: string,
    dest_path = "/root/a.txt",
    src_project_id = SRC_PROJECT_ID,
  ) {
    const { updateCopyStatus } = await import("./copy-db");
    await updateCopyStatus({
      copy_id,
      key: { ...key(dest_path), src_project_id },
      status: "done",
    });
  }
  // Hold the lock that queueing and cleanup of this snapshot take.
  async function holdSnapshotLock(snapshot_id = "snap-x") {
    const lockKey = `project-copy-snapshot:${SRC_PROJECT_ID}:${snapshot_id}`;
    const client = await getPool().connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    } catch (err) {
      client.release(true);
      throw err;
    }
    return async () => {
      let unlocked = false;
      try {
        const { rows } = await client.query(
          "SELECT pg_advisory_unlock(hashtext($1)) AS unlocked",
          [lockKey],
        );
        unlocked = (rows[0]?.unlocked ?? rows[0]?.pg_advisory_unlock) === true;
      } finally {
        // a client that may still hold the lock is closed, not pooled
        client.release(unlocked ? undefined : true);
      }
    };
  }
  async function settledWithin(promise: Promise<unknown>, ms: number) {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, ms));
    return settled;
  }
  async function activeRowsFor(snapshot_id: string) {
    const { rows } = await getPool().query(
      `SELECT copy_id FROM project_copies
        WHERE src_project_id=$1 AND snapshot_id=$2
          AND status = ANY($3::text[])`,
      [SRC_PROJECT_ID, snapshot_id, ["queued", "applying", "failed"]],
    );
    return rows;
  }

  beforeEach(() => {
    mockDeleteBackup.mockClear();
  });

  it("deletes a snapshot the copy created once it is done", async () => {
    const row = await queue({ snapshot_created: true });
    await finish(row.copy_id);
    expect(mockDeleteBackup).toHaveBeenCalledWith({
      project_id: SRC_PROJECT_ID,
      id: "snap-x",
    });
  });

  it("never deletes a reused snapshot when the copy is done", async () => {
    const row = await queue({ snapshot_created: false });
    await finish(row.copy_id);
    expect(mockDeleteBackup).not.toHaveBeenCalled();
  });

  it("never deletes for a row written before the flag existed", async () => {
    const row = await queue({ snapshot_created: true });
    await getPool().query(
      "UPDATE project_copies SET snapshot_created=NULL WHERE copy_id=$1",
      [row.copy_id],
    );
    await finish(row.copy_id);
    expect(mockDeleteBackup).not.toHaveBeenCalled();
  });

  it("never deletes a snapshot that another copy reused", async () => {
    // Copy A made the snapshot; copy B reused it.
    const a = await queue({
      dest_path: "/root/a1.txt",
      snapshot_created: true,
    });
    const b = await queue({
      dest_path: "/root/b1.txt",
      snapshot_created: false,
    });
    await finish(a.copy_id, "/root/a1.txt");
    await finish(b.copy_id, "/root/b1.txt");
    expect(mockDeleteBackup).not.toHaveBeenCalled();
  });

  it("never deletes a backup that copy after copy reused", async () => {
    // Copies of an unchanged file keep reusing the source's latest backup.
    for (const dest_path of ["/root/r1.txt", "/root/r2.txt", "/root/r3.txt"]) {
      const row = await queue({ dest_path, snapshot_created: false });
      await finish(row.copy_id, dest_path);
    }
    expect(mockDeleteBackup).not.toHaveBeenCalled();
  });

  it("deletes a snapshot shared only by copies that created it, after the last one", async () => {
    const a = await queue({
      dest_path: "/root/a2.txt",
      snapshot_created: true,
    });
    const b = await queue({
      dest_path: "/root/b2.txt",
      snapshot_created: true,
    });
    await finish(a.copy_id, "/root/a2.txt");
    expect(mockDeleteBackup).not.toHaveBeenCalled();
    await finish(b.copy_id, "/root/b2.txt");
    expect(mockDeleteBackup).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "on cancel, deletes only a created snapshot (created=%s)",
    async (snapshot_created) => {
      const { cancelCopy } = await import("./copy-db");
      await queue({ snapshot_created });
      await cancelCopy(key("/root/a.txt"));
      expect(mockDeleteBackup).toHaveBeenCalledTimes(snapshot_created ? 1 : 0);
    },
  );

  it.each([true, false])(
    "on cancel by operation, deletes only a created snapshot (created=%s)",
    async (snapshot_created) => {
      const { cancelCopiesByOpId } = await import("./copy-db");
      const op_id = "77777777-7777-4777-8777-777777777777";
      await queue({ snapshot_created, op_id });
      await cancelCopiesByOpId({ op_id });
      expect(mockDeleteBackup).toHaveBeenCalledTimes(snapshot_created ? 1 : 0);
    },
  );

  it.each([true, false])(
    "on expiry, deletes only a created snapshot (created=%s)",
    async (snapshot_created) => {
      const { expireCopies } = await import("./copy-db");
      await queue({
        snapshot_created,
        expires_at: new Date(Date.now() - 1000),
      });
      await expireCopies();
      expect(mockDeleteBackup).toHaveBeenCalledTimes(snapshot_created ? 1 : 0);
    },
  );

  it.each([true, false])(
    "when a requeue replaces the snapshot, deletes the old one only if created (created=%s)",
    async (snapshot_created) => {
      // A requeue of the same operation's row (op_id is part of the key).
      const op_id = "99999999-9999-4999-8999-999999999990";
      await queue({ snapshot_id: "snap-old", snapshot_created, op_id });
      await queue({ snapshot_id: "snap-new", snapshot_created: true, op_id });
      const deleted = mockDeleteBackup.mock.calls.map(([opts]) => opts.id);
      expect(deleted).toEqual(snapshot_created ? ["snap-old"] : []);
    },
  );

  it("replaces the flag together with the snapshot on a requeue", async () => {
    const op_id = "99999999-9999-4999-8999-999999999991";
    const first = await queue({
      snapshot_id: "snap-1",
      snapshot_created: true,
      op_id,
    });
    expect(first.snapshot_created).toBe(true);
    const second = await queue({
      snapshot_id: "snap-2",
      snapshot_created: false,
      op_id,
    });
    expect(second.copy_id).toBe(first.copy_id);
    expect(second.snapshot_id).toBe("snap-2");
    expect(second.snapshot_created).toBe(false);
  });

  it("stores the flag when inserting a missing row", async () => {
    const { insertCopyRowIfMissing } = await import("./copy-db");
    const row = await insertCopyRowIfMissing({
      ...key("/root/c.txt"),
      op_id: "88888888-8888-4888-8888-888888888888",
      snapshot_id: "snap-ins",
      snapshot_created: true,
      expires_at: new Date(Date.now() + 60_000),
    });
    expect(row?.snapshot_created).toBe(true);
  });

  it("(order a) a copy queued before cleanup decides keeps the snapshot", async () => {
    const a = await queue({
      dest_path: "/root/a3.txt",
      snapshot_created: true,
    });
    // copy B reuses the snapshot before A finishes
    await queue({ dest_path: "/root/b3.txt", snapshot_created: false });
    await finish(a.copy_id, "/root/a3.txt");
    expect(mockDeleteBackup).not.toHaveBeenCalled();
    expect(await activeRowsFor("snap-x")).toHaveLength(1);
  });

  it("(order b) a copy queued after cleanup decided is refused", async () => {
    const { CopySnapshotUnavailableError } = await import("./copy-db");
    const a = await queue({ snapshot_created: true });
    await finish(a.copy_id);
    expect(mockDeleteBackup).toHaveBeenCalledTimes(1);
    await expect(
      queue({ dest_path: "/root/b4.txt", snapshot_created: false }),
    ).rejects.toBeInstanceOf(CopySnapshotUnavailableError);
    const { insertCopyRowIfMissing } = await import("./copy-db");
    await expect(
      insertCopyRowIfMissing({
        ...key("/root/b5.txt"),
        op_id: "88888888-8888-4888-8888-888888888881",
        snapshot_id: "snap-x",
        snapshot_created: false,
        expires_at: new Date(Date.now() + 60_000),
      }),
    ).rejects.toBeInstanceOf(CopySnapshotUnavailableError);
    expect(await activeRowsFor("snap-x")).toHaveLength(0);
  });

  it("queueing waits for the snapshot's lock", async () => {
    const release = await holdSnapshotLock();
    let queued: Promise<unknown> | undefined;
    try {
      queued = queue({ snapshot_created: false });
      expect(await settledWithin(queued, 300)).toBe(false);
    } finally {
      await release();
    }
    await expect(queued!).resolves.toBeDefined();
  });

  it("insert-if-missing waits for the snapshot's lock", async () => {
    const { insertCopyRowIfMissing } = await import("./copy-db");
    const release = await holdSnapshotLock();
    let inserted: Promise<unknown> | undefined;
    try {
      inserted = insertCopyRowIfMissing({
        ...key("/root/w1.txt"),
        op_id: "88888888-8888-4888-8888-888888888882",
        snapshot_id: "snap-x",
        snapshot_created: false,
        expires_at: new Date(Date.now() + 60_000),
      });
      // (no other query here: the test pool's two connections are held by
      // the lock holder and the waiting insert)
      expect(await settledWithin(inserted, 300)).toBe(false);
    } finally {
      await release();
    }
    // the insert went ahead once the lock was free
    await expect(inserted!).resolves.toMatchObject({ snapshot_id: "snap-x" });
    expect(await activeRowsFor("snap-x")).toHaveLength(1);
  });

  it("an insert paused after its claim check keeps a concurrent cleanup from claiming", async () => {
    const { insertCopyRowIfMissing } = await import("./copy-db");
    // copy A made snap-x; its row is the only reference so far
    const a = await queue({
      dest_path: "/root/i1.txt",
      snapshot_created: true,
    });
    const pool = getPool();
    const realConnect = pool.connect.bind(pool);
    let reachedCheck!: () => void;
    const atCheck = new Promise<void>((resolve) => (reachedCheck = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    let paused = false;
    // pause the insert right after its claim check, before its INSERT
    const connect = jest
      .spyOn(pool, "connect")
      .mockImplementation((async () => {
        const client: any = await realConnect();
        const realQuery = client.query.bind(client);
        const realRelease = client.release.bind(client);
        client.query = async (sql: any, params?: any) => {
          const result = await realQuery(sql, params);
          if (
            !paused &&
            `${sql}`.includes("FROM project_copy_snapshot_claims") &&
            `${sql}`.trim().startsWith("SELECT 1")
          ) {
            paused = true;
            reachedCheck();
            await resumed;
          }
          return result;
        };
        client.release = (arg?: any) => {
          client.query = realQuery;
          client.release = realRelease;
          return realRelease(arg);
        };
        return client;
      }) as any);
    let inserting: Promise<unknown> | undefined;
    let cleanup: Promise<void> | undefined;
    try {
      inserting = insertCopyRowIfMissing({
        ...key("/root/i2.txt"),
        op_id: "88888888-8888-4888-8888-888888888883",
        snapshot_id: "snap-x",
        snapshot_created: false,
        expires_at: new Date(Date.now() + 60_000),
      });
      await atCheck;
      connect.mockRestore();
      // copy A finishes now, so its cleanup races the paused insert
      cleanup = finish(a.copy_id, "/root/i1.txt");
      // with the lock, cleanup can't decide while the insert is paused
      expect(await settledWithin(cleanup, 300)).toBe(false);
    } finally {
      connect.mockRestore();
      resume();
      // Both finish even when an assertion above failed, so the test never
      // leaves work running for the leak check.
      await Promise.allSettled([inserting, cleanup]);
    }
    const insertResult = await inserting!.then(
      (row) => row,
      (err) => err,
    );
    await cleanup;
    const { rows: claims } = await getPool().query(
      "SELECT 1 FROM project_copy_snapshot_claims WHERE src_project_id=$1 AND snapshot_id=$2",
      [SRC_PROJECT_ID, "snap-x"],
    );
    const active = await activeRowsFor("snap-x");
    // never both a deletion claim and a live row that references the snapshot
    expect(claims.length > 0 && active.length > 0).toBe(false);
    // the insert went first: cleanup saw its row and neither claimed nor deleted
    expect(insertResult).not.toBeInstanceOf(Error);
    expect(claims).toHaveLength(0);
    expect(mockDeleteBackup).not.toHaveBeenCalled();
    expect(active).toHaveLength(1);
  });

  it("cleanup decides under the snapshot's lock", async () => {
    const a = await queue({ snapshot_created: true });
    const release = await holdSnapshotLock();
    let finished: Promise<void> | undefined;
    try {
      finished = finish(a.copy_id);
      expect(await settledWithin(finished, 300)).toBe(false);
      expect(mockDeleteBackup).not.toHaveBeenCalled();
    } finally {
      await release();
    }
    await finished!;
    expect(mockDeleteBackup).toHaveBeenCalledTimes(1);
  });

  it("records the claim before asking the host to delete", async () => {
    const a = await queue({ snapshot_created: true });
    let claimedBeforeDelete: number | undefined;
    mockDeleteBackup.mockImplementationOnce(async () => {
      const { rows } = await getPool().query(
        "SELECT 1 FROM project_copy_snapshot_claims WHERE src_project_id=$1 AND snapshot_id=$2",
        [SRC_PROJECT_ID, "snap-x"],
      );
      claimedBeforeDelete = rows.length;
    });
    await finish(a.copy_id);
    expect(claimedBeforeDelete).toBe(1);
  });

  it("keeps refusing the snapshot after a delete whose response was lost", async () => {
    const { CopySnapshotUnavailableError, releaseCreatedCopySnapshot } =
      await import("./copy-db");
    const a = await queue({ snapshot_created: true });
    // the host deleted it, then the response was lost
    mockDeleteBackup.mockRejectedValueOnce(new Error("timeout"));
    await finish(a.copy_id);
    expect(mockDeleteBackup).toHaveBeenCalledTimes(1);
    await expect(
      queue({ dest_path: "/root/b6.txt", snapshot_created: false }),
    ).rejects.toBeInstanceOf(CopySnapshotUnavailableError);
    // and a later cleanup does not ask again
    await releaseCreatedCopySnapshot({
      src_project_id: SRC_PROJECT_ID,
      snapshot_id: "snap-x",
    });
    expect(mockDeleteBackup).toHaveBeenCalledTimes(1);
  });

  it("refuses a snapshot that a requeue's cleanup removed", async () => {
    const { CopySnapshotUnavailableError } = await import("./copy-db");
    const op_id = "99999999-9999-4999-8999-999999999992";
    await queue({ snapshot_id: "snap-old", snapshot_created: true, op_id });
    await queue({ snapshot_id: "snap-new", snapshot_created: true, op_id });
    expect(mockDeleteBackup.mock.calls.map(([o]) => o.id)).toEqual([
      "snap-old",
    ]);
    await expect(
      queue({
        dest_path: "/root/b8.txt",
        snapshot_id: "snap-old",
        snapshot_created: false,
      }),
    ).rejects.toBeInstanceOf(CopySnapshotUnavailableError);
  });

  it("decides only from this source project's rows", async () => {
    // Another project has a finished row, created by its copy, with the same
    // snapshot id.
    const other = await queue({
      dest_path: "/root/o1.txt",
      snapshot_created: true,
      src_project_id: OTHER_SRC_PROJECT_ID,
    });
    await finish(other.copy_id, "/root/o1.txt", OTHER_SRC_PROJECT_ID);
    expect(mockDeleteBackup.mock.calls.map(([o]) => o.project_id)).toEqual([
      OTHER_SRC_PROJECT_ID,
    ]);
    mockDeleteBackup.mockClear();
    // This project's copy reused its own backup with that id; a requeue then
    // replaces the row.
    const op_id = "99999999-9999-4999-8999-999999999993";
    await queue({ snapshot_id: "snap-x", snapshot_created: false, op_id });
    await queue({ snapshot_id: "snap-z", snapshot_created: false, op_id });
    expect(mockDeleteBackup).not.toHaveBeenCalled();
  });

  const snapshotLockKey = (snapshot_id = "snap-x") =>
    `project-copy-snapshot:${SRC_PROJECT_ID}:${snapshot_id}`;
  const rowLockKey = (op_id: string, dest_path = "/root/a.txt") =>
    `project-copy-row:${JSON.stringify([
      op_id,
      SRC_PROJECT_ID,
      "a.txt",
      DEST_PROJECT_ID,
      dest_path,
    ])}`;
  // A connection checked out BEFORE the operation, so the operation's locks
  // are on other backends and a leaked lock can't be re-entered here.
  async function pinObserver() {
    const client = await getPool().connect();
    return {
      canLock: async (lockKey: string) => {
        const { rows } = await client.query(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
          [lockKey],
        );
        const locked = rows[0]?.locked === true;
        if (locked) {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
            lockKey,
          ]);
        }
        return locked;
      },
      advisoryLockOwners: async () => {
        const { rows } = await client.query(
          "SELECT COUNT(DISTINCT pid)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid <> pg_backend_pid()",
        );
        return Number(rows[0]?.n ?? 0);
      },
      release: () => client.release(),
    };
  }

  it("leaves the snapshot's lock free after queueing, refusing and cleanup", async () => {
    const { CopySnapshotUnavailableError } = await import("./copy-db");
    const observer = await pinObserver();
    try {
      const a = await queue({ snapshot_created: true });
      expect(await observer.canLock(snapshotLockKey())).toBe(true);
      await finish(a.copy_id);
      expect(mockDeleteBackup).toHaveBeenCalledTimes(1);
      expect(await observer.canLock(snapshotLockKey())).toBe(true);
      await expect(
        queue({ dest_path: "/root/l2.txt", snapshot_created: false }),
      ).rejects.toBeInstanceOf(CopySnapshotUnavailableError);
      expect(await observer.canLock(snapshotLockKey())).toBe(true);
    } finally {
      observer.release();
    }
  });

  it("does a requeue's row lock, snapshot locks and cleanup on one connection", async () => {
    const op_id = "99999999-9999-4999-8999-999999999995";
    await queue({ snapshot_id: "snap-a", snapshot_created: true, op_id });
    const observer = await pinObserver();
    try {
      const pool = getPool();
      const connect = jest.spyOn(pool, "connect");
      let ownersDuringCleanup: number | undefined;
      mockDeleteBackup.mockImplementationOnce(async () => {
        // the requeue still holds its row lock while it cleans up snap-a
        ownersDuringCleanup = await observer.advisoryLockOwners();
      });
      let connections: number;
      try {
        await queue({ snapshot_id: "snap-b", snapshot_created: true, op_id });
      } finally {
        // (mockRestore also clears the recorded calls)
        connections = connect.mock.calls.length;
        connect.mockRestore();
      }
      expect(connections).toBe(1);
      expect(mockDeleteBackup).toHaveBeenCalledTimes(1);
      expect(ownersDuringCleanup).toBeLessThanOrEqual(1);
    } finally {
      observer.release();
    }
  });

  it("closes a connection whose snapshot unlock was not confirmed under a row lock", async () => {
    const op_id = "99999999-9999-4999-8999-999999999996";
    await queue({ snapshot_id: "snap-a", snapshot_created: false, op_id });
    const observer = await pinObserver();
    try {
      const pool = getPool();
      const realConnect = pool.connect.bind(pool);
      const releases: any[] = [];
      const connect = jest
        .spyOn(pool, "connect")
        .mockImplementation((async () => {
          const client: any = await realConnect();
          const realQuery = client.query.bind(client);
          const realRelease = client.release.bind(client);
          let failed = false;
          client.query = async (sql: any, params?: any) => {
            if (
              !failed &&
              `${sql}`.includes("pg_advisory_unlock") &&
              `${params?.[0]}`.startsWith("project-copy-snapshot:")
            ) {
              // the unlock is not confirmed and the lock stays held
              failed = true;
              return { rows: [{ unlocked: false }], rowCount: 1 };
            }
            return await realQuery(sql, params);
          };
          client.release = (arg?: any) => {
            releases.push(arg);
            client.query = realQuery;
            client.release = realRelease;
            return realRelease(arg);
          };
          return client;
        }) as any);
      try {
        await queue({ snapshot_id: "snap-b", snapshot_created: false, op_id });
      } finally {
        connect.mockRestore();
      }
      // closed, not returned to the pool, though the row unlock succeeded
      expect(releases).toEqual([true]);
      expect(await observer.canLock(snapshotLockKey("snap-b"))).toBe(true);
      expect(await observer.canLock(rowLockKey(op_id))).toBe(true);
    } finally {
      observer.release();
    }
  });

  it("keeps the snapshot when its lock can't be had in time", async () => {
    const { setCopySnapshotLockTimeoutForTests, CopySnapshotLockTimeoutError } =
      await import("./copy-db");
    const a = await queue({ snapshot_created: true });
    const release = await holdSnapshotLock();
    try {
      setCopySnapshotLockTimeoutForTests(300);
      // cleanup gives up without deciding anything
      await finish(a.copy_id);
      expect(mockDeleteBackup).not.toHaveBeenCalled();
      // queueing fails instead of going ahead unlocked
      await expect(
        queue({ dest_path: "/root/t2.txt", snapshot_created: false }),
      ).rejects.toBeInstanceOf(CopySnapshotLockTimeoutError);
    } finally {
      setCopySnapshotLockTimeoutForTests(60_000);
      await release();
    }
    const { rows } = await getPool().query(
      "SELECT 1 FROM project_copy_snapshot_claims WHERE src_project_id=$1",
      [SRC_PROJECT_ID],
    );
    expect(rows).toHaveLength(0);
    expect(await activeRowsFor("snap-x")).toHaveLength(0);
  });

  it("serializes concurrent requeues of the same row", async () => {
    const op_id = "99999999-9999-4999-8999-999999999994";
    await queue({ snapshot_id: "snap-a", snapshot_created: true, op_id });
    const returned = await Promise.all([
      queue({ snapshot_id: "snap-b", snapshot_created: true, op_id }),
      queue({ snapshot_id: "snap-c", snapshot_created: true, op_id }),
    ]);
    const { rows } = await getPool().query(
      "SELECT snapshot_id FROM project_copies WHERE op_id=$1",
      [op_id],
    );
    expect(rows).toHaveLength(1);
    const current = rows[0].snapshot_id;
    expect(returned.map((row) => row.snapshot_id)).toContain(current);
    const replaced = current === "snap-b" ? "snap-c" : "snap-b";
    // each replaced snapshot is cleaned up exactly once, the current one never
    expect(mockDeleteBackup.mock.calls.map(([o]) => o.id).sort()).toEqual(
      ["snap-a", replaced].sort(),
    );
    const { rows: claims } = await getPool().query(
      "SELECT snapshot_id FROM project_copy_snapshot_claims WHERE src_project_id=$1 ORDER BY snapshot_id",
      [SRC_PROJECT_ID],
    );
    expect(claims.map((row) => row.snapshot_id)).toEqual(
      ["snap-a", replaced].sort(),
    );
    expect(await activeRowsFor("snap-a")).toHaveLength(0);
    expect(await activeRowsFor(replaced)).toHaveLength(0);
  });

  it("a requeue paused after reading its row keeps a concurrent requeue of that row waiting", async () => {
    const op_id = "99999999-9999-4999-8999-999999999997";
    await queue({ snapshot_id: "snap-a", snapshot_created: true, op_id });
    const pool = getPool();
    const realConnect = pool.connect.bind(pool);
    let reachedRead!: () => void;
    const atRead = new Promise<void>((resolve) => (reachedRead = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    let refusedRowLock!: () => void;
    const rowLockRefused = new Promise<void>(
      (resolve) => (refusedRowLock = resolve),
    );
    const realPg = !(
      process.env.COCALC_TEST_USE_PGLITE || process.env.COCALC_DB === "pglite"
    );
    // The row's lock key, computed here from the row, not taken from the code.
    const rowKey = `project-copy-row:${JSON.stringify([
      op_id,
      SRC_PROJECT_ID,
      "a.txt",
      DEST_PROJECT_ID,
      "/root/a.txt",
    ])}`;
    let paused = false;
    let pausedNow = false;
    let firstHeldRowKey = false;
    let firstPid: number | undefined;
    // The first requeue pauses right after reading the row it replaces; a
    // later connection reports when its try for that exact row key is refused
    // while the first is paused.  The wrapper only observes: every query runs
    // unchanged and its real result is returned as is.
    const connect = jest
      .spyOn(pool, "connect")
      .mockImplementation((async () => {
        const client: any = await realConnect();
        const realQuery = client.query.bind(client);
        const realRelease = client.release.bind(client);
        const pauses = !paused;
        client.query = async (sql: any, params?: any) => {
          const result = await realQuery(sql, params);
          const rowLockTry =
            `${sql}`.includes("pg_try_advisory_lock") && params?.[0] === rowKey;
          if (pauses && rowLockTry && result?.rows?.[0]?.locked === true) {
            firstHeldRowKey = true;
          }
          if (
            pauses &&
            !paused &&
            `${sql}`.includes("SELECT snapshot_id, snapshot_created")
          ) {
            paused = true;
            if (realPg) {
              firstPid = (await realQuery("SELECT pg_backend_pid() AS pid"))
                .rows[0].pid;
            }
            pausedNow = true;
            reachedRead();
            await resumed;
            pausedNow = false;
          }
          if (
            !pauses &&
            pausedNow &&
            firstHeldRowKey &&
            rowLockTry &&
            result?.rows?.[0]?.locked === false
          ) {
            refusedRowLock();
          }
          return result;
        };
        client.release = (arg?: any) => {
          client.query = realQuery;
          client.release = realRelease;
          return realRelease(arg);
        };
        return client;
      }) as any);
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      first = queue({ snapshot_id: "snap-b", snapshot_created: true, op_id });
      await atRead;
      second = queue({ snapshot_id: "snap-c", snapshot_created: true, op_id });
      // the second requeue is refused the row's lock while the first holds it
      const refused = await Promise.race([
        rowLockRefused.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 5000);
        }),
      ]);
      expect(refused).toBe(true);
      if (realPg) {
        // The database agrees: that row's lock is granted to exactly the
        // paused first requeue's backend.  One connection outside the pool.
        const { Client } = await import("pg");
        const witness = new Client({ database: "smc" });
        let closeError: unknown;
        try {
          await witness.connect();
          const { rows: holders } = await witness.query(
            `SELECT pid FROM pg_locks
              WHERE locktype = 'advisory' AND granted AND objsubid = 1
                AND classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295)
                AND objid::bigint = (hashtext($1)::bigint & 4294967295)`,
            [rowKey],
          );
          expect(typeof firstPid).toBe("number");
          expect(holders.map((row) => row.pid)).toEqual([firstPid]);
        } finally {
          try {
            await witness.end();
          } catch (err) {
            closeError = err ?? new Error("witness end failed");
          }
        }
        // the witness must be closed for sure, before the leak check
        expect(closeError).toBeUndefined();
      }
      expect(await settledWithin(second, 300)).toBe(false);
    } finally {
      clearTimeout(timer);
      connect.mockRestore();
      resume();
      // Both requeues finish even when an assertion above failed, so the
      // test never leaves work running for the leak check.
      await Promise.allSettled([first, second]);
    }
    await first;
    await second;
    const { rows } = await getPool().query(
      "SELECT snapshot_id FROM project_copies WHERE op_id=$1",
      [op_id],
    );
    expect(rows.map((row) => row.snapshot_id)).toEqual(["snap-c"]);
    // each replaced snapshot is cleaned up exactly once
    expect(mockDeleteBackup.mock.calls.map(([o]) => o.id).sort()).toEqual([
      "snap-a",
      "snap-b",
    ]);
  });

  describe("a copy that fails after making its backup", () => {
    it("keeps the backup while its own queued row needs it", async () => {
      const { releaseCreatedCopySnapshot } = await import("./copy-db");
      await queue({ snapshot_created: true });
      await releaseCreatedCopySnapshot({
        src_project_id: SRC_PROJECT_ID,
        snapshot_id: "snap-x",
      });
      expect(mockDeleteBackup).not.toHaveBeenCalled();
    });

    it("keeps the backup another copy reused", async () => {
      const { releaseCreatedCopySnapshot } = await import("./copy-db");
      const b = await queue({ snapshot_created: false });
      await finish(b.copy_id);
      await releaseCreatedCopySnapshot({
        src_project_id: SRC_PROJECT_ID,
        snapshot_id: "snap-x",
      });
      expect(mockDeleteBackup).not.toHaveBeenCalled();
    });

    it("(control) deletes it, with a claim, when nothing references it", async () => {
      const { releaseCreatedCopySnapshot, CopySnapshotUnavailableError } =
        await import("./copy-db");
      await releaseCreatedCopySnapshot({
        src_project_id: SRC_PROJECT_ID,
        snapshot_id: "snap-x",
      });
      expect(mockDeleteBackup).toHaveBeenCalledTimes(1);
      await expect(queue({ snapshot_created: false })).rejects.toBeInstanceOf(
        CopySnapshotUnavailableError,
      );
    });
  });
});
