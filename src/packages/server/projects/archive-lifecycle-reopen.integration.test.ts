/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { uuid } from "@cocalc/util/misc";
import { lockProjectRehomeFence } from "@cocalc/database/postgres/project-rehome-fence";
import { updateProjectArchiveLifecycleJob } from "./archive-lifecycle-db";
import {
  reopenStuckProjectArchive,
  reserveStuckArchiveJob,
} from "./archive-lifecycle-maintenance";

// Row locks and their recheck after a concurrent commit need PostgreSQL.
const describePostgres =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe.skip : describe;

const ADMIN = "77777777-7777-4777-8777-777777777777";

describePostgres("admin reopen reservation (PostgreSQL)", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
    // the reopen checks for a running backup (the columns it reads)
    await getPool().query(
      `CREATE TABLE IF NOT EXISTS long_running_operations
         (kind TEXT, scope_id UUID, status TEXT, dismissed_at TIMESTAMP,
          input JSONB, result JSONB, created_at TIMESTAMPTZ DEFAULT NOW(),
          started_at TIMESTAMPTZ)`,
    );
  }, 15000);

  afterAll(async () => {
    await getPool().end();
  });

  // A project stuck in state archiving under an automatic job stopped by
  // files over the backup limit.
  async function stuckProject() {
    const project_id = uuid();
    const job_id = uuid();
    const host_id = uuid();
    await getPool().query(
      `INSERT INTO project_archive_lifecycle_jobs
         (id, project_id, owning_bay_id, host_id, reason, policy_version,
          status, report_only, failure_category, dedupe_key)
       VALUES ($1, $2, $3, $4, 'free-inactive', 1, 'failed', false,
               'oversized-files', $5)`,
      [job_id, project_id, getConfiguredBayId(), host_id, `test:${job_id}`],
    );
    await getPool().query(
      `INSERT INTO projects
         (project_id, title, owning_bay_id, host_id, provisioned, state,
          archive_lifecycle_job_id)
       VALUES ($1, 'stuck archive', $2, $3, true,
               '{"state":"archiving"}'::jsonb, $4)`,
      [project_id, getConfiguredBayId(), host_id, job_id],
    );
    return { project_id, job_id };
  }

  const reserve = (project_id: string, token: string) =>
    reserveStuckArchiveJob({
      db: getPool(),
      project_id,
      actor_account_id: ADMIN,
      token,
    });

  const expireReservation = async (job_id: string) =>
    await getPool().query(
      `UPDATE project_archive_lifecycle_jobs
          SET evidence = jsonb_set(
                evidence, '{admin_reopen_reservation,at}',
                to_jsonb((NOW() - INTERVAL '1 hour')::text))
        WHERE id = $1`,
      [job_id],
    );

  it("reserves once, and refuses a second attempt while the reservation is live", async () => {
    const { project_id, job_id } = await stuckProject();
    expect(await reserve(project_id, "token-a")).toEqual([
      expect.objectContaining({
        job_id,
        previous_status: "failed",
        previous_failure_category: "oversized-files",
      }),
    ]);
    expect(await reserve(project_id, "token-b")).toEqual([]);
  });

  it("(control) takes over an expired reservation while the project is still archiving", async () => {
    const { project_id, job_id } = await stuckProject();
    await reserve(project_id, "token-a");
    await expireReservation(job_id);
    expect(await reserve(project_id, "token-b")).toEqual([
      expect.objectContaining({
        job_id,
        // the category the first reservation replaced, not admin-reopen
        previous_failure_category: "oversized-files",
      }),
    ]);
  });

  it("reserves nothing after waiting on an attempt that finishes the reopen", async () => {
    const { project_id, job_id } = await stuckProject();
    await reserve(project_id, "token-a");
    // attempt A is slow (a host call), so its lease expires
    await expireReservation(job_id);

    // A finalizes as reopenStuckProjectArchive does: its fenced job update,
    // then the project, in one transaction left open while B tries
    const a = await getPool().connect();
    let committed = false;
    try {
      await a.query("BEGIN");
      const finalized = await a.query(
        `UPDATE project_archive_lifecycle_jobs
            SET status = 'canceled',
                evidence = (evidence - 'admin_reopen_reservation')
                  || '{"admin_reopen": {"reason": "test"}}'::jsonb
          WHERE id = $1
            AND failure_category = 'admin-reopen'
            AND evidence -> 'admin_reopen_reservation' ->> 'token' = 'token-a'`,
        [job_id],
      );
      expect(finalized.rowCount).toBe(1);
      await a.query(
        `UPDATE projects
            SET state = '{"state":"opened"}'::jsonb,
                archive_lifecycle_job_id = NULL
          WHERE project_id = $1`,
        [project_id],
      );

      // B tries to take over the expired lease: it waits on A's locks
      let bDone = false;
      const b = reserve(project_id, "token-b").finally(() => {
        bDone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(bDone).toBe(false);

      await a.query("COMMIT");
      committed = true;
      // after A's commit, B rechecks the committed rows and reserves nothing
      await expect(b).resolves.toEqual([]);
    } finally {
      if (!committed) await a.query("ROLLBACK").catch(() => undefined);
      a.release();
    }

    const {
      rows: [job],
    } = await getPool().query(
      `SELECT status, failure_category, evidence
         FROM project_archive_lifecycle_jobs WHERE id = $1`,
      [job_id],
    );
    // A's finished reopen is intact
    expect(job).toMatchObject({
      status: "canceled",
      failure_category: "admin-reopen",
    });
    expect(job.evidence.admin_reopen).toEqual({ reason: "test" });
    expect(job.evidence.admin_reopen_reservation).toBeUndefined();
  });
  it("holds the rehome fence from before the reservation until the reopen commits", async () => {
    const { project_id, job_id } = await stuckProject();
    // the host call pauses until released here
    let hostCalled!: () => void;
    const atHost = new Promise<void>((resolve) => (hostCalled = resolve));
    let resumeHost!: () => void;
    const hostResumed = new Promise<void>((resolve) => (resumeHost = resolve));
    const reopening = reopenStuckProjectArchive({
      project_id,
      actor_account_id: ADMIN,
      reason: "test",
      releaseArchiveFreeze: async () => {
        hostCalled();
        await hostResumed;
        return { status: "released" as const };
      },
    });
    // (a refusal before the host call fails the test here)
    await Promise.race([atHost, reopening]);

    // the job is reserved but nothing is committed yet
    const {
      rows: [before],
    } = await getPool().query(
      `SELECT failure_category FROM project_archive_lifecycle_jobs WHERE id = $1`,
      [job_id],
    );
    expect(before.failure_category).toBe("oversized-files");

    // a new rehome (createProjectRehomeOperation) takes the same fence first:
    // it waits for the reopen instead of copying the archiving project
    const r = await getPool().connect();
    let rehomeHasFence = false;
    try {
      await r.query("BEGIN");
      const fenced = lockProjectRehomeFence({ db: r, project_id }).then(() => {
        rehomeHasFence = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(rehomeHasFence).toBe(false);

      resumeHost();
      await expect(reopening).resolves.toEqual({
        job_id,
        freeze_status: "released",
      });
      await fenced;
      // once it has the fence, the rehome sees the reopened project
      const {
        rows: [project],
      } = await r.query(
        `SELECT state ->> 'state' AS state, archive_lifecycle_job_id
           FROM projects WHERE project_id = $1`,
        [project_id],
      );
      expect(project).toEqual({
        state: "opened",
        archive_lifecycle_job_id: null,
      });
    } finally {
      await r.query("ROLLBACK").catch(() => undefined);
      r.release();
    }
  });

  it("refuses while a freeze-capable backup has an unresolved uncertain outcome, however old", async () => {
    const { project_id, job_id } = await stuckProject();
    // the worker lost track of it days ago, and it was dismissed in the UI:
    // its host request may still be queued and freeze the volume later
    await getPool().query(
      `INSERT INTO long_running_operations
         (kind, scope_id, status, dismissed_at, input, result, created_at)
       VALUES ('project-backup', $1, 'failed', NOW(),
               '{"freeze_source": true}'::jsonb,
               '{"archive_freeze_recovery": "uncertain"}'::jsonb,
               NOW() - INTERVAL '30 days')`,
      [project_id],
    );
    let hostCalls = 0;
    const reopen = () =>
      reopenStuckProjectArchive({
        project_id,
        actor_account_id: ADMIN,
        reason: "test",
        releaseArchiveFreeze: async () => {
          hostCalls += 1;
          return { status: "already-writable" as const };
        },
      });
    await expect(reopen()).rejects.toThrow(/no proven-safe outcome/);
    expect(hostCalls).toBe(0);

    // (control) once a checked release resolves it, the reopen proceeds
    await getPool().query(
      `UPDATE long_running_operations
          SET result = '{"archive_freeze_recovery": "released"}'::jsonb
        WHERE scope_id = $1`,
      [project_id],
    );
    await expect(reopen()).resolves.toEqual({
      job_id,
      freeze_status: "already-writable",
    });
    expect(hostCalls).toBe(1);
  });

  it("refuses while a freeze-capable backup was canceled after it started, until its recovery is proven safe", async () => {
    const { project_id, job_id } = await stuckProject();
    // canceled after the worker claimed it: the host request wasn't
    await getPool().query(
      `INSERT INTO long_running_operations
         (kind, scope_id, status, input, result, started_at)
       VALUES ('project-backup', $1, 'canceled',
               '{"freeze_source": true}'::jsonb, '{}'::jsonb, NOW())`,
      [project_id],
    );
    // (control) one canceled before it ever started never reached the host
    await getPool().query(
      `INSERT INTO long_running_operations
         (kind, scope_id, status, input, result)
       VALUES ('project-backup', $1, 'canceled',
               '{"freeze_source": true}'::jsonb, '{}'::jsonb)`,
      [project_id],
    );
    const reopen = () =>
      reopenStuckProjectArchive({
        project_id,
        actor_account_id: ADMIN,
        reason: "test",
        releaseArchiveFreeze: async () => ({
          status: "already-writable" as const,
        }),
      });
    await expect(reopen()).rejects.toThrow(/no proven-safe outcome/);
    await getPool().query(
      `UPDATE long_running_operations
          SET result = '{"archive_freeze_recovery": "not-started"}'::jsonb
        WHERE scope_id = $1 AND started_at IS NOT NULL`,
      [project_id],
    );
    await expect(reopen()).resolves.toEqual({
      job_id,
      freeze_status: "already-writable",
    });
  });

  it("keeps a finished admin reopen when the job's worker records its failure late", async () => {
    const { project_id, job_id } = await stuckProject();
    await reopenStuckProjectArchive({
      project_id,
      actor_account_id: ADMIN,
      reason: "test",
      releaseArchiveFreeze: async () => ({
        status: "already-writable" as const,
      }),
    });
    // the archive worker, still finishing, records its own failure
    await updateProjectArchiveLifecycleJob({
      job_id,
      status: "failed",
      failure_category: "archive-storage",
      error: "late",
    });
    const {
      rows: [job],
    } = await getPool().query(
      `SELECT status, failure_category, next_attempt_at, evidence
         FROM project_archive_lifecycle_jobs WHERE id = $1`,
      [job_id],
    );
    expect(job.status).toBe("canceled");
    expect(job.failure_category).toBe("admin-reopen");
    expect(job.next_attempt_at).toBeNull();
    expect(job.evidence.admin_reopen.reason).toBe("test");
  });
});
