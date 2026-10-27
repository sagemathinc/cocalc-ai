/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  MAX_NEW_MERGE_APPROVALS_PER_PROJECT_PER_HOUR,
  MAX_PENDING_MERGE_APPROVALS_PER_PROJECT,
  type MergeApprovalGitHubSnapshot,
} from "@cocalc/util/merge-approval";
import { MergeApprovalStore, type NewMergeApprovalRequest } from "./store";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const sha = (c: string) => c.repeat(40);

function snapshot(head_sha: string): MergeApprovalGitHubSnapshot {
  return {
    title: "t",
    state: "open",
    draft: false,
    author: "a",
    base_ref: "main",
    head_ref: "b",
    head_sha,
    html_url: "https://github.com/o/r/pull/1",
    additions: 1,
    deletions: 0,
    changed_files: 1,
    files: [],
    files_truncated: false,
    checks: [],
    reviews: [],
    read_at: new Date().toISOString(),
  };
}

function newRequest(
  project_id: string,
  overrides: Partial<NewMergeApprovalRequest> = {},
): NewMergeApprovalRequest {
  const head_sha = overrides.head_sha ?? sha("a");
  return {
    repo: "o/r",
    pr_number: 1,
    head_sha,
    base_ref: "main",
    github_snapshot: snapshot(head_sha),
    agent_note: "please",
    requested_by: { account_id: randomUUID(), project_id },
    ...overrides,
  };
}

describeDb("merge approval store", () => {
  let store: MergeApprovalStore;

  beforeAll(async () => {
    await initEphemeralDatabase({});
    store = new MergeApprovalStore(getPool());
  }, 60_000);

  afterAll(async () => {
    await getPool().end();
  });

  const decideOpts = (request_id: string) => ({
    request_id,
    account_id: randomUUID(),
    decision: "approve" as const,
    comment: "ok",
    session_hash: "session",
    factor_level: "totp",
  });

  it("creates a pending request that expires in 7 days", async () => {
    const req = await store.create(newRequest(randomUUID()));
    expect(req.status).toBe("pending");
    const ttl = Date.parse(req.expires_at) - Date.parse(req.created_at);
    expect(ttl).toBe(7 * 24 * 60 * 60 * 1000);
    await expect(store.get(req.id)).resolves.toEqual(req);
  });

  it("returns the open request for the same head instead of a new one", async () => {
    const project_id = randomUUID();
    const a = await store.create(newRequest(project_id));
    const b = await store.create(newRequest(project_id));
    expect(b.id).toBe(a.id);
  });

  it("supersedes open requests for an older head of the same PR", async () => {
    const project_id = randomUUID();
    const old = await store.create(newRequest(project_id, { pr_number: 7 }));
    const next = await store.create(
      newRequest(project_id, { pr_number: 7, head_sha: sha("b") }),
    );
    expect(next.id).not.toBe(old.id);
    expect((await store.get(old.id))?.status).toBe("superseded");
    await expect(store.decide(decideOpts(old.id))).rejects.toThrow(
      "is superseded, not pending",
    );
  });

  it("records one decision and moves the request to approved or rejected", async () => {
    const approved = await store.create(newRequest(randomUUID()));
    const result = await store.decide(decideOpts(approved.id));
    expect(result.request.status).toBe("approved");
    expect(result.decision).toMatchObject({
      request_id: approved.id,
      decision: "approve",
      factor_level: "totp",
      session_hash: "session",
    });
    await expect(store.decide(decideOpts(approved.id))).rejects.toThrow(
      "is approved, not pending",
    );

    const rejected = await store.create(
      newRequest(randomUUID(), { pr_number: 2 }),
    );
    const r = await store.decide({
      ...decideOpts(rejected.id),
      decision: "reject",
    });
    expect(r.request.status).toBe("rejected");
  });

  it("marks an expired request expired and refuses to decide it", async () => {
    const req = await store.create(newRequest(randomUUID(), { pr_number: 3 }));
    // Only the database's own clock decides expiry; age the row past it by
    // disabling the trigger just for this setup step.
    await getPool().query(
      "ALTER TABLE merge_approval_requests DISABLE TRIGGER merge_approval_requests_integrity_trigger",
    );
    try {
      await getPool().query(
        "UPDATE merge_approval_requests SET expires_at=now() - interval '1 second' WHERE id=$1",
        [req.id],
      );
    } finally {
      await getPool().query(
        "ALTER TABLE merge_approval_requests ENABLE TRIGGER merge_approval_requests_integrity_trigger",
      );
    }
    await expect(store.decide(decideOpts(req.id))).rejects.toMatchObject({
      code: "expired",
    });
    expect((await store.get(req.id))?.status).toBe("expired");
    await expect(store.decide(decideOpts(req.id))).rejects.toThrow(
      "is expired, not pending",
    );
  });

  it("refuses unknown requests", async () => {
    await expect(store.decide(decideOpts(randomUUID()))).rejects.toThrow(
      "not found",
    );
  });

  it("limits open requests per project", async () => {
    const project_id = randomUUID();
    const pool = getPool();
    // Fill the project's open requests directly, spread over the past
    // day so the hourly limit doesn't trigger first.
    for (let i = 0; i < MAX_PENDING_MERGE_APPROVALS_PER_PROJECT; i++) {
      await pool.query(
        `INSERT INTO merge_approval_requests
           (id, repo, pr_number, head_sha, base_ref, github_snapshot,
            agent_note, requested_by, created_at, expires_at, status)
         VALUES ($1,'o/r',$2,$3,'main','{}'::jsonb,'',$4::jsonb,
                 now() - interval '2 hours', now() + interval '1 day','pending')`,
        [
          randomUUID(),
          1000 + i,
          sha("c"),
          JSON.stringify({ account_id: randomUUID(), project_id }),
        ],
      );
    }
    await expect(
      store.create(newRequest(project_id, { pr_number: 5000 })),
    ).rejects.toMatchObject({ code: 429 });
    // Another project is unaffected.
    await expect(
      store.create(newRequest(randomUUID(), { pr_number: 5000 })),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("lets a new head replace an old one at the open-request limit", async () => {
    const project_id = randomUUID();
    const first = await store.create(
      newRequest(project_id, { repo: "o/full", pr_number: 1 }),
    );
    await getPool().query(
      `INSERT INTO merge_approval_requests
         (id, repo, pr_number, head_sha, base_ref, github_snapshot,
          agent_note, requested_by, created_at, expires_at, status)
       SELECT gen_random_uuid(),'o/full',100 + n,$1,'main','{}'::jsonb,'',
              $2::jsonb, now() - interval '2 hours', now() + interval '1 day',
              'pending'
         FROM generate_series(1, $3::int) AS n`,
      [
        sha("c"),
        JSON.stringify({ account_id: randomUUID(), project_id }),
        MAX_PENDING_MERGE_APPROVALS_PER_PROJECT - 1,
      ],
    );
    await expect(
      store.create(newRequest(project_id, { repo: "o/full", pr_number: 2 })),
    ).rejects.toMatchObject({ code: 429 });
    const next = await store.create(
      newRequest(project_id, {
        repo: "o/full",
        pr_number: 1,
        head_sha: sha("b"),
      }),
    );
    expect(next.status).toBe("pending");
    expect((await store.get(first.id))?.status).toBe("superseded");
  });

  it("leaves one open request per PR when projects race", async () => {
    const heads = ["d", "e", "f", "1", "2", "3"].map(sha);
    await Promise.all(
      heads.map((head_sha) =>
        store.create(
          newRequest(randomUUID(), {
            repo: "o/race",
            pr_number: 1,
            head_sha,
          }),
        ),
      ),
    );
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM merge_approval_requests WHERE repo='o/race' AND status='pending'",
    );
    expect(rows[0].n).toBe(1);
  });

  it("limits new requests per project per hour", async () => {
    const project_id = randomUUID();
    for (let i = 0; i < MAX_NEW_MERGE_APPROVALS_PER_PROJECT_PER_HOUR; i++) {
      const req = await store.create(
        newRequest(project_id, { repo: "o/hourly", pr_number: i + 1 }),
      );
      // Decided requests still count toward the hourly limit.
      await store.decide({ ...decideOpts(req.id), decision: "reject" });
    }
    await expect(
      store.create(
        newRequest(project_id, { repo: "o/hourly", pr_number: 999 }),
      ),
    ).rejects.toThrow("in the last hour");
  });

  it("refuses to write while an integrity trigger is disabled", async () => {
    const req = await store.create(newRequest(randomUUID(), { pr_number: 4 }));
    await getPool().query(
      "ALTER TABLE merge_approval_decisions DISABLE TRIGGER merge_approval_decisions_integrity_trigger",
    );
    try {
      await expect(store.decide(decideOpts(req.id))).rejects.toThrow(
        "merge approvals are unavailable",
      );
      await expect(
        store.create(newRequest(randomUUID(), { pr_number: 5 })),
      ).rejects.toThrow("merge approvals are unavailable");
    } finally {
      await getPool().query(
        "ALTER TABLE merge_approval_decisions ENABLE TRIGGER merge_approval_decisions_integrity_trigger",
      );
    }
    expect((await store.get(req.id))?.status).toBe("pending");
  });
});
