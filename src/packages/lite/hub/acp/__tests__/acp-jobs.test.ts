#!/usr/bin/env ts-node
import { randomUUID } from "node:crypto";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  acpAdmissionLimitsFromEffectiveLimits,
  admitAcpJobExecution,
  admitAcpJobCreation,
  withoutRecoveryLineage,
  mergeAcpAdmissionLimits,
  setAcpAdmissionDenialRecorder,
  throwIfAcpAdmissionDenied,
  type AcpAdmissionDenialEvent,
} from "../admission";
import {
  claimNextQueuedAcpJobForThread,
  cancelQueuedAcpJob,
  cancelQueuedAcpJobForControl,
  cancelQueuedRecoveryJobsForThread,
  clearAcpJobRecoveryIntent,
  clearQueuedAcpJobWorkerAffinity,
  countCreatedAcpJobsForAccountSince,
  countQueuedAcpJobsForAccount,
  countQueuedAcpJobsForThread,
  countRunningAcpJobsForAccount,
  countRunningAcpJobsForProject,
  countRunningAcpJobsForWorker,
  decodeAcpJobRequest,
  enqueueAcpJob,
  enqueueAcpJobCancelingQueuedRecoveries,
  ACP_FENCE_INTENT_RESUME_PENDING,
  ACP_FENCE_INTENT_RESUME_READY,
  ACP_FENCE_INTENT_RESUMING,
  ACP_FENCE_INTENT_STOPPED,
  ACP_FENCED_JOB_CANCELED_ERROR,
  acpJobHasLiveFenceResume,
  adoptAcpJobsFencedWithoutIntent,
  fenceAcpJobsForProject,
  getAcpJob,
  getAcpJobByOpId,
  hasNewerNonRecoveryAcpJob,
  latestAcpJobUpdateForWorker,
  listAcpJobsByRecoveryParent,
  listAcpJobsWithFenceIntent,
  listAcpJobsWithRecoveryIntent,
  listQueuedAcpJobs,
  listQueuedAcpJobThreadKeys,
  listQueuedAcpJobsForThread,
  nextQueuedAcpJobAvailability,
  oldestClaimableQueuedAcpJobTimestamp,
  oldestQueuedAcpJobTimestamp,
  moveAcpJobFenceIntent,
  releaseAcpProjectFenceResumes,
  requeueFencedAcpJob,
  resendCanceledAcpJob,
  reprioritizeAcpJobImmediate,
  stopAcpFenceResumesForThread,
  setAcpJobState,
  removeRetiredAutomationJobs,
} from "../../sqlite/acp-jobs";

const FENCE_LIST = {
  pendingMaxAgeMs: 60 * 60_000,
  resumingStaleMs: 5 * 60_000,
};

async function delay(ms = 2): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRequest({
  userMessageId,
  assistantMessageId,
  assistantDate,
}: {
  userMessageId: string;
  assistantMessageId: string;
  assistantDate: string;
}) {
  return {
    project_id: "00000000-1000-4000-8000-000000000000",
    account_id: "00000000-1000-4000-8000-000000000001",
    session_id: randomUUID(),
    prompt: assistantMessageId,
    config: {
      workingDirectory: "/tmp",
    },
    chat: {
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp-jobs-order.chat",
      thread_id: "thread-1",
      parent_message_id: userMessageId,
      message_id: assistantMessageId,
      message_date: assistantDate,
      sender_id: "openai-codex-agent",
    },
  };
}

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
  listQueuedAcpJobs();
});

beforeEach(() => {
  setAcpAdmissionDenialRecorder(undefined);
  getAcpDatabase().prepare("DELETE FROM acp_jobs").run();
});

afterAll(() => {
  closeAcpDatabase();
});

describe("retired thread automations", () => {
  it("drops their jobs and settings so nothing runs, recovers or retries them", () => {
    const keep = enqueueAcpJob(
      makeRequest({
        userMessageId: "human-1",
        assistantMessageId: "assistant-1",
        assistantDate: "2026-01-01T00:00:00.000Z",
      }),
    );
    const db = getAcpDatabase();
    const legacy = (op_id: string, request: object) =>
      db
        .prepare(
          `INSERT INTO acp_jobs (op_id, project_id, account_id, path, thread_id,
             user_message_id, assistant_message_id, assistant_message_date,
             state, request_json, created_at, updated_at)
           VALUES (?, 'p', 'a', 'x.chat', 't', ?, ?, '2026-01-01', 'queued', ?, 0, 0)`,
        )
        .run(op_id, `u-${op_id}`, op_id, JSON.stringify(request));
    legacy("command-1", { request_kind: "command", command: "date" });
    legacy("scheduled-1", {
      request_kind: "codex",
      prompt: "daily summary",
      chat: { automation_id: "automation-1" },
    });
    db.exec("CREATE TABLE IF NOT EXISTS acp_automations (automation_id TEXT)");
    removeRetiredAutomationJobs(db);
    expect(
      db
        .prepare("SELECT op_id FROM acp_jobs ORDER BY op_id")
        .all()
        .map((row: any) => row.op_id),
    ).toEqual([keep.op_id]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='acp_automations'",
        )
        .all(),
    ).toEqual([]);
  });
});

describe("acp job queue ordering", () => {
  it("reports queued backlog only when the worker can claim it", () => {
    const unassigned = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-unassigned-backlog",
        assistantMessageId: "assistant-unassigned-backlog",
        assistantDate: "2026-09-15T00:00:00.000Z",
      }) as any,
    );
    const owned = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-owned-backlog",
        assistantMessageId: "assistant-owned-backlog",
        assistantDate: "2026-09-15T00:01:00.000Z",
      }) as any,
      { preferred_worker_id: "worker-current" },
    );
    const foreign = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-foreign-backlog",
        assistantMessageId: "assistant-foreign-backlog",
        assistantDate: "2026-09-15T00:02:00.000Z",
      }) as any,
      { preferred_worker_id: "worker-old" },
    );
    const delayed = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-delayed-owned-backlog",
        assistantMessageId: "assistant-delayed-owned-backlog",
        assistantDate: "2026-09-15T00:03:00.000Z",
      }) as any,
      {
        preferred_worker_id: "worker-current",
        available_at: Date.now() + 60_000,
      },
    );
    const db = getAcpDatabase();
    const setThread = db.prepare(
      "UPDATE acp_jobs SET path = ?, thread_id = ? WHERE op_id = ?",
    );
    setThread.run(
      "/tmp/unassigned.chat",
      "thread-unassigned",
      unassigned.op_id,
    );
    setThread.run("/tmp/owned.chat", "thread-owned", owned.op_id);
    setThread.run("/tmp/foreign.chat", "thread-foreign", foreign.op_id);
    setThread.run("/tmp/delayed.chat", "thread-delayed", delayed.op_id);
    const setUpdatedAt = db.prepare(
      "UPDATE acp_jobs SET created_at = ?, updated_at = ? WHERE op_id = ?",
    );
    setUpdatedAt.run(10_000, 10_000, unassigned.op_id);
    setUpdatedAt.run(20_000, 20_000, owned.op_id);
    setUpdatedAt.run(5_000, 5_000, foreign.op_id);
    setUpdatedAt.run(1_000, 1_000, delayed.op_id);

    expect(
      oldestClaimableQueuedAcpJobTimestamp({
        worker_id: "worker-current",
        include_unassigned: true,
      }),
    ).toBe(10_000);
    expect(
      oldestClaimableQueuedAcpJobTimestamp({
        worker_id: "worker-current",
        include_unassigned: false,
      }),
    ).toBe(20_000);
    expect(
      oldestClaimableQueuedAcpJobTimestamp({
        worker_id: "worker-unrelated",
        include_unassigned: false,
      }),
    ).toBeUndefined();
  });

  it("does not report a later claimable job behind a foreign-pinned thread head", () => {
    const foreign = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-foreign-thread-head",
        assistantMessageId: "assistant-foreign-thread-head",
        assistantDate: "2026-09-15T00:00:00.000Z",
      }) as any,
      { preferred_worker_id: "worker-old" },
    );
    const unassigned = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-behind-foreign-head",
        assistantMessageId: "assistant-behind-foreign-head",
        assistantDate: "2026-09-15T00:01:00.000Z",
      }) as any,
    );
    const setUpdatedAt = getAcpDatabase().prepare(
      "UPDATE acp_jobs SET created_at = ?, updated_at = ? WHERE op_id = ?",
    );
    setUpdatedAt.run(10_000, 10_000, foreign.op_id);
    setUpdatedAt.run(20_000, 20_000, unassigned.op_id);

    expect(
      oldestClaimableQueuedAcpJobTimestamp({
        worker_id: "worker-current",
        include_unassigned: true,
      }),
    ).toBeUndefined();
    expect(
      oldestClaimableQueuedAcpJobTimestamp({
        worker_id: "worker-old",
        include_unassigned: false,
      }),
    ).toBe(10_000);
    expect(
      oldestClaimableQueuedAcpJobTimestamp({
        worker_id: "worker-current",
        include_unassigned: true,
        known_worker_ids: [],
        reclaimable_worker_ids: [],
      }),
    ).toBe(10_000);
    expect(
      oldestClaimableQueuedAcpJobTimestamp({
        worker_id: "worker-current",
        include_unassigned: true,
        known_worker_ids: ["worker-old"],
        reclaimable_worker_ids: [],
      }),
    ).toBeUndefined();
    expect(
      oldestClaimableQueuedAcpJobTimestamp({
        worker_id: "worker-current",
        include_unassigned: true,
        known_worker_ids: ["worker-old"],
        reclaimable_worker_ids: ["worker-old"],
      }),
    ).toBe(10_000);
  });

  it("reports a worker's latest job transition as queue progress", () => {
    const queued = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-worker-progress",
        assistantMessageId: "assistant-worker-progress",
        assistantDate: "2026-09-14T21:09:00.000Z",
      }) as any,
    );
    const running = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-progress",
      worker_bundle_version: "bundle-progress",
    });
    expect(running).toBeDefined();

    setAcpJobState({
      op_id: queued.op_id,
      state: "completed",
      worker_id: "worker-progress",
    });

    expect(latestAcpJobUpdateForWorker("worker-progress")).toBe(
      getAcpJobByOpId(queued.op_id)?.updated_at,
    );
    expect(latestAcpJobUpdateForWorker("another-worker")).toBeUndefined();
  });

  it("terminally fences queued and running work for one stopped project", () => {
    const queued = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-fenced-queued",
        assistantMessageId: "assistant-fenced-queued",
        assistantDate: "2026-09-16T00:00:00.000Z",
      }) as any,
    );
    const running = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-fenced-running",
        assistantMessageId: "assistant-fenced-running",
        assistantDate: "2026-09-16T00:00:01.000Z",
      }) as any,
    );
    const setCreatedAt = getAcpDatabase().prepare(
      "UPDATE acp_jobs SET created_at = ?, updated_at = ? WHERE op_id = ?",
    );
    setCreatedAt.run(10_000, 10_000, queued.op_id);
    setCreatedAt.run(20_000, 20_000, running.op_id);
    claimNextQueuedAcpJobForThread({
      project_id: running.project_id,
      path: running.path,
      thread_id: running.thread_id,
    });
    // The first row is claimed first; keep the identities explicit.
    expect(getAcpJobByOpId(queued.op_id)?.state).toBe("running");
    const result = fenceAcpJobsForProject({
      project_id: queued.project_id,
      reason: "project restart fence",
    });
    expect(result).toEqual({ queued: 1, running: 1 });
    expect(getAcpJobByOpId(queued.op_id)?.state).toBe("interrupted");
    expect(getAcpJobByOpId(running.op_id)?.state).toBe("canceled");
    setAcpJobState({
      op_id: queued.op_id,
      state: "completed",
      worker_id: "stale-worker",
    });
    expect(getAcpJobByOpId(queued.op_id)?.state).toBe("interrupted");
  });

  it("fences a running generic harness as uncertain, not confirmed interrupted", () => {
    const request = {
      ...makeRequest({
        userMessageId: "harness-running",
        assistantMessageId: "harness-answer",
        assistantDate: "2026-09-21T00:00:00.000Z",
      }),
      runtime: { version: 1, kind: "acp" },
    };
    const running = enqueueAcpJob(request as any);
    claimNextQueuedAcpJobForThread({
      project_id: running.project_id,
      path: running.path,
      thread_id: running.thread_id,
      worker_id: "worker-before-restart",
    });
    const queued = enqueueAcpJob({
      ...request,
      chat: {
        ...request.chat,
        parent_message_id: "harness-queued",
        message_id: "harness-queued-answer",
        message_date: "2026-09-21T00:00:01.000Z",
      },
    } as any);

    expect(
      fenceAcpJobsForProject({
        project_id: running.project_id,
        reason: "project restart fence",
      }),
    ).toEqual({ queued: 1, running: 1 });
    expect(getAcpJobByOpId(running.op_id)).toMatchObject({
      state: "error",
      error: "project restart fence",
      // Owed to the chat and the sender, not a failure recovery.
      recovery_code: ACP_FENCE_INTENT_STOPPED,
    });
    expect(listAcpJobsWithRecoveryIntent()).toHaveLength(0);
    expect(getAcpJobByOpId(queued.op_id)?.state).toBe("canceled");
    setAcpJobState({
      op_id: running.op_id,
      state: "completed",
      worker_id: "worker-before-restart",
    });
    expect(getAcpJobByOpId(running.op_id)?.state).toBe("error");
    expect(listQueuedAcpJobs()).toHaveLength(0);
  });

  it("records restart resumes that a start releases and a later stop overrides", () => {
    const fenceProject = (resume: boolean) => {
      const running = enqueueAcpJob(
        makeRequest({
          userMessageId: `user-running-${resume}`,
          assistantMessageId: `assistant-running-${resume}`,
          assistantDate: "2026-10-14T00:00:00.000Z",
        }) as any,
      );
      claimNextQueuedAcpJobForThread({
        project_id: running.project_id,
        path: running.path,
        thread_id: running.thread_id,
      });
      const queued = enqueueAcpJob(
        makeRequest({
          userMessageId: `user-queued-${resume}`,
          assistantMessageId: `assistant-queued-${resume}`,
          assistantDate: "2026-10-14T00:00:01.000Z",
        }) as any,
      );
      expect(
        fenceAcpJobsForProject({
          project_id: running.project_id,
          reason: "project restarted",
          resume,
        }),
      ).toEqual({ queued: 1, running: 1 });
      return { running, queued };
    };

    const { running, queued } = fenceProject(true);
    expect(getAcpJobByOpId(running.op_id)).toMatchObject({
      state: "interrupted",
      recovery_code: ACP_FENCE_INTENT_RESUME_PENDING,
    });
    expect(getAcpJobByOpId(queued.op_id)).toMatchObject({
      state: "canceled",
      recovery_code: ACP_FENCE_INTENT_RESUME_PENDING,
    });
    // Neither is a failure recovery, and nothing is runnable yet.
    expect(listAcpJobsWithRecoveryIntent()).toHaveLength(0);
    // The held message has nothing to show until the start; the cut-off turn
    // still needs its chat to say so.
    expect(
      listAcpJobsWithFenceIntent(FENCE_LIST).map((row) => row.op_id),
    ).toEqual([running.op_id]);
    expect(listQueuedAcpJobs()).toHaveLength(0);
    expect(requeueFencedAcpJob(queued.op_id)).toBeUndefined();

    // A start releases fresh resumes only.
    expect(
      releaseAcpProjectFenceResumes({
        project_id: running.project_id,
        maxAgeMs: 60_000,
        now: Date.now() + 2 * 60_000,
      }),
    ).toBe(0);
    expect(
      releaseAcpProjectFenceResumes({
        project_id: running.project_id,
        maxAgeMs: 60_000,
      }),
    ).toBe(2);
    expect(getAcpJobByOpId(running.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_RESUME_READY,
    );
    // Moves are atomic: only one pass can take a given intent.
    expect(
      moveAcpJobFenceIntent({
        op_id: running.op_id,
        from: ACP_FENCE_INTENT_RESUME_PENDING,
        to: null,
      }),
    ).toBe(false);
    expect(requeueFencedAcpJob(running.op_id)).toBeUndefined();
    expect(requeueFencedAcpJob(queued.op_id)).toMatchObject({
      state: "queued",
      recovery_code: null,
      finished_at: null,
      error: null,
    });

    // A stop before the resume ran makes the rest stopped work.
    getAcpDatabase().prepare("DELETE FROM acp_jobs").run();
    const second = fenceProject(true);
    fenceAcpJobsForProject({
      project_id: second.running.project_id,
      reason: "project stopped",
    });
    expect(getAcpJobByOpId(second.running.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_STOPPED,
    );
    expect(getAcpJobByOpId(second.queued.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_STOPPED,
    );
    expect(
      releaseAcpProjectFenceResumes({
        project_id: second.running.project_id,
        maxAgeMs: 60_000,
      }),
    ).toBe(0);

    // So does an interrupt in the thread.
    getAcpDatabase().prepare("DELETE FROM acp_jobs").run();
    const third = fenceProject(true);
    expect(
      stopAcpFenceResumesForThread({
        project_id: third.running.project_id,
        path: third.running.path,
        thread_id: third.running.thread_id,
      }),
    ).toBe(2);
    expect(getAcpJobByOpId(third.running.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_STOPPED,
    );
  });

  it("leaves a restart's hold alone when a send-now finds the job already held", () => {
    const queued = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-held-send-now",
        assistantMessageId: "assistant-held-send-now",
        assistantDate: "2026-10-15T00:00:00.000Z",
      }) as any,
    );
    const key = {
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
      account_id: queued.account_id,
      thread_id: queued.thread_id,
    };
    // The restart fence lands between the send-now's checks and its claim.
    fenceAcpJobsForProject({
      project_id: queued.project_id,
      reason: "project restarted",
      resume: true,
    });
    expect(cancelQueuedAcpJobForControl(key)).toMatchObject({
      canceled: false,
      job: { state: "canceled" },
    });
    // Still held for resume: the send-now did not end the user's turn.
    expect(acpJobHasLiveFenceResume(getAcpJobByOpId(queued.op_id))).toBe(true);
  });

  it("lets a cancel end a held message and refuses to resend it while held", () => {
    const queued = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-held",
        assistantMessageId: "assistant-held",
        assistantDate: "2026-10-15T00:00:00.000Z",
      }) as any,
    );
    fenceAcpJobsForProject({
      project_id: queued.project_id,
      reason: "project restarted",
      resume: true,
    });
    const key = {
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
      account_id: queued.account_id,
      thread_id: queued.thread_id,
    };
    // Only the turn's owner can cancel or resend it, held or not.
    const other = {
      ...key,
      account_id: "00000000-1000-4000-8000-0000000000ff",
    };
    expect(cancelQueuedAcpJob(other)).toBeUndefined();
    expect(resendCanceledAcpJob(other)).toBeUndefined();
    expect(acpJobHasLiveFenceResume(getAcpJobByOpId(queued.op_id))).toBe(true);
    // Resend cannot run it while the restart holds it.
    expect(resendCanceledAcpJob(key)).toMatchObject({
      state: "canceled",
      recovery_code: ACP_FENCE_INTENT_RESUME_PENDING,
    });
    expect(acpJobHasLiveFenceResume(getAcpJobByOpId(queued.op_id))).toBe(true);
    // Cancel ends it: no resume after the start, and no fence adopts it.
    expect(cancelQueuedAcpJob(key)).toMatchObject({
      state: "canceled",
      recovery_code: null,
      error: ACP_FENCED_JOB_CANCELED_ERROR,
    });
    expect(
      releaseAcpProjectFenceResumes({
        project_id: queued.project_id,
        maxAgeMs: 60_000,
      }),
    ).toBe(0);
    expect(
      adoptAcpJobsFencedWithoutIntent({
        project_id: queued.project_id,
        reason: "project restarted",
        since: 0,
      }),
    ).toBe(0);
  });

  it("enqueues a resumed turn only while its parent's claim holds", () => {
    const parent = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-parent",
        assistantMessageId: "assistant-parent",
        assistantDate: "2026-10-15T00:00:00.000Z",
      }) as any,
    );
    claimNextQueuedAcpJobForThread({
      project_id: parent.project_id,
      path: parent.path,
      thread_id: parent.thread_id,
    });
    fenceAcpJobsForProject({
      project_id: parent.project_id,
      reason: "project restarted",
      resume: true,
    });
    releaseAcpProjectFenceResumes({
      project_id: parent.project_id,
      maxAgeMs: 60_000,
    });
    expect(
      moveAcpJobFenceIntent({
        op_id: parent.op_id,
        from: ACP_FENCE_INTENT_RESUME_READY,
        to: ACP_FENCE_INTENT_RESUMING,
      }),
    ).toBe(true);
    const child = (n: number) => ({
      ...makeRequest({
        userMessageId: `user-child-${n}`,
        assistantMessageId: `assistant-child-${n}`,
        assistantDate: `2026-10-15T00:00:0${n}.000Z`,
      }),
      recovery_parent_op_id: parent.op_id,
      recovery_count: 1,
    });
    // A stop wins: it ends the claim, so the insert refuses.
    fenceAcpJobsForProject({
      project_id: parent.project_id,
      reason: "project stopped",
    });
    expect(getAcpJobByOpId(parent.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_STOPPED,
    );
    expect(
      enqueueAcpJob(child(1) as any, {
        require_parent_fence_intent: ACP_FENCE_INTENT_RESUMING,
      }),
    ).toBeUndefined();
    // With the claim intact, it inserts.
    moveAcpJobFenceIntent({
      op_id: parent.op_id,
      from: ACP_FENCE_INTENT_STOPPED,
      to: ACP_FENCE_INTENT_RESUMING,
    });
    expect(
      enqueueAcpJob(child(2) as any, {
        require_parent_fence_intent: ACP_FENCE_INTENT_RESUMING,
      })?.state,
    ).toBe("queued");
  });

  it("polls fence intents fairly: settled pending rows wait, attempts rotate", () => {
    const db = getAcpDatabase();
    const jobs = [0, 1, 2].map((n) => {
      const job = enqueueAcpJob(
        makeRequest({
          userMessageId: `user-fair-${n}`,
          assistantMessageId: `assistant-fair-${n}`,
          assistantDate: `2026-10-15T00:00:0${n}.000Z`,
        }) as any,
      );
      return job;
    });
    fenceAcpJobsForProject({
      project_id: jobs[0].project_id,
      reason: "project stopped",
    });
    db.prepare("UPDATE acp_jobs SET updated_at = ? WHERE op_id = ?").run(
      1,
      jobs[0].op_id,
    );
    expect(
      listAcpJobsWithFenceIntent({ ...FENCE_LIST, limit: 1 })[0].op_id,
    ).toBe(jobs[0].op_id);
    // A failed attempt touches the row; the next poll starts elsewhere.
    moveAcpJobFenceIntent({
      op_id: jobs[0].op_id,
      from: ACP_FENCE_INTENT_STOPPED,
      to: ACP_FENCE_INTENT_STOPPED,
    });
    expect(
      listAcpJobsWithFenceIntent({ ...FENCE_LIST, limit: 1 })[0].op_id,
    ).not.toBe(jobs[0].op_id);
  });

  it("adopts only the rows this fence ended without an intent", () => {
    const db = getAcpDatabase();
    const job = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-old-worker",
        assistantMessageId: "assistant-old-worker",
        assistantDate: "2026-10-15T00:00:00.000Z",
      }) as any,
    );
    // What an older worker's sweep leaves: fenced, no intent.
    const fencedAt = Date.now();
    db.prepare(
      `UPDATE acp_jobs SET state = 'canceled', error = ?, recovery_code = NULL,
         finished_at = ? WHERE op_id = ?`,
    ).run("project restarted", fencedAt, job.op_id);
    expect(
      adoptAcpJobsFencedWithoutIntent({
        project_id: job.project_id,
        reason: "project restarted",
        since: fencedAt + 1,
        resume: true,
      }),
    ).toBe(0);
    expect(
      adoptAcpJobsFencedWithoutIntent({
        project_id: job.project_id,
        reason: "project restarted",
        since: fencedAt,
        resume: true,
      }),
    ).toBe(1);
    expect(getAcpJobByOpId(job.op_id)?.recovery_code).toBe(
      ACP_FENCE_INTENT_RESUME_PENDING,
    );
  });

  it("does not claim a delayed recovery until its availability time", () => {
    const request = {
      ...makeRequest({
        userMessageId: "user-delayed-recovery",
        assistantMessageId: "assistant-delayed-recovery",
        assistantDate: "2026-03-08T00:00:00.000Z",
      }),
      recovery_parent_op_id: "parent-delayed-recovery",
      recovery_reason: "model capacity",
      recovery_count: 1,
    };
    const availableAt = Date.now() + 15 * 60_000;
    const queued = enqueueAcpJob(request as any, {
      available_at: availableAt,
    });

    expect(queued.available_at).toBe(availableAt);
    expect(nextQueuedAcpJobAvailability()).toBe(availableAt);
    expect(listQueuedAcpJobs()).toHaveLength(1);
    expect(listQueuedAcpJobThreadKeys()).toHaveLength(0);
    expect(
      claimNextQueuedAcpJobForThread({
        project_id: queued.project_id,
        path: queued.path,
        thread_id: queued.thread_id,
      }),
    ).toBeUndefined();

    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET available_at = ? WHERE op_id = ?")
      .run(Date.now() - 1, queued.op_id);
    expect(listQueuedAcpJobThreadKeys()).toHaveLength(1);
    expect(
      claimNextQueuedAcpJobForThread({
        project_id: queued.project_id,
        path: queued.path,
        thread_id: queued.thread_id,
      })?.op_id,
    ).toBe(queued.op_id);
  });

  it("atomically rejects recovery after a newer user job", async () => {
    const source = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-recovery-source",
        assistantMessageId: "assistant-recovery-source",
        assistantDate: "2026-03-08T00:00:00.000Z",
      }) as any,
    );
    await delay();
    enqueueAcpJob(
      makeRequest({
        userMessageId: "user-newer-turn",
        assistantMessageId: "assistant-newer-turn",
        assistantDate: "2026-03-08T00:01:00.000Z",
      }) as any,
    );
    const guard = {
      source_op_id: source.op_id,
      source_created_at: source.created_at,
    };
    expect(
      hasNewerNonRecoveryAcpJob({
        project_id: source.project_id,
        path: source.path,
        thread_id: source.thread_id,
        guard,
      }),
    ).toBe(true);

    const recovery = enqueueAcpJob(
      {
        ...makeRequest({
          userMessageId: "user-stale-recovery",
          assistantMessageId: "assistant-stale-recovery",
          assistantDate: "2026-03-08T00:02:00.000Z",
        }),
        recovery_parent_op_id: source.op_id,
        recovery_reason: "lost turn",
        recovery_count: 1,
      } as any,
      {
        reject_if_newer_non_recovery_than: guard,
      },
    );

    expect(recovery).toBeUndefined();
    expect(listQueuedAcpJobs()).toHaveLength(2);
  });

  it("does not count a canceled newer message as superseding, unless a fence holds it", () => {
    const source = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-supersede-source",
        assistantMessageId: "assistant-supersede-source",
        assistantDate: "2026-03-08T00:00:00.000Z",
      }) as any,
    );
    const newer = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-supersede-newer",
        assistantMessageId: "assistant-supersede-newer",
        assistantDate: "2026-03-08T00:01:00.000Z",
      }) as any,
    );
    const superseded = () =>
      hasNewerNonRecoveryAcpJob({
        project_id: source.project_id,
        path: source.path,
        thread_id: source.thread_id,
        guard: {
          source_op_id: source.op_id,
          source_created_at: source.created_at,
        },
      });
    expect(superseded()).toBe(true);

    // Held by a restart: it may still run.
    getAcpDatabase()
      .prepare(
        "UPDATE acp_jobs SET state = 'canceled', recovery_code = ? WHERE op_id = ?",
      )
      .run(ACP_FENCE_INTENT_RESUME_PENDING, newer.op_id);
    expect(superseded()).toBe(true);

    // Canceled by a stop: the intent only tells the sender; it never runs.
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET recovery_code = ? WHERE op_id = ?")
      .run(ACP_FENCE_INTENT_STOPPED, newer.op_id);
    expect(superseded()).toBe(false);

    // Canceled for good: it never runs.
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET recovery_code = NULL WHERE op_id = ?")
      .run(newer.op_id);
    expect(superseded()).toBe(false);
  });

  it("uses insertion order for supersession within one millisecond", () => {
    const older = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-same-ms-older",
        assistantMessageId: "assistant-same-ms-older",
        assistantDate: "2026-03-08T00:00:00.100Z",
      }) as any,
    );
    const source = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-same-ms-source",
        assistantMessageId: "assistant-same-ms-source",
        assistantDate: "2026-03-08T00:00:00.200Z",
      }) as any,
    );
    const sameTimestamp = Date.now();
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET created_at = ? WHERE op_id IN (?, ?)")
      .run(sameTimestamp, older.op_id, source.op_id);
    const guard = {
      source_op_id: source.op_id,
      source_created_at: sameTimestamp,
    };

    expect(
      hasNewerNonRecoveryAcpJob({
        project_id: source.project_id,
        path: source.path,
        thread_id: source.thread_id,
        guard,
      }),
    ).toBe(false);

    enqueueAcpJob(
      makeRequest({
        userMessageId: "user-same-ms-newer",
        assistantMessageId: "assistant-same-ms-newer",
        assistantDate: "2026-03-08T00:00:00.300Z",
      }) as any,
    );
    getAcpDatabase()
      .prepare("UPDATE acp_jobs SET created_at = ? WHERE op_id = ?")
      .run(sameTimestamp, "assistant-same-ms-newer");

    expect(
      hasNewerNonRecoveryAcpJob({
        project_id: source.project_id,
        path: source.path,
        thread_id: source.thread_id,
        guard,
      }),
    ).toBe(true);
  });

  it("atomically enqueues a user job while canceling queued recovery", () => {
    const recovery = enqueueAcpJob(
      {
        ...makeRequest({
          userMessageId: "user-pending-recovery",
          assistantMessageId: "assistant-pending-recovery",
          assistantDate: "2026-03-08T00:00:00.000Z",
        }),
        recovery_parent_op_id: "failed-parent",
        recovery_reason: "lost turn",
        recovery_count: 1,
      } as any,
      { available_at: Date.now() + 15 * 60_000 },
    );

    const { job, canceled } = enqueueAcpJobCancelingQueuedRecoveries(
      makeRequest({
        userMessageId: "user-atomic-new-turn",
        assistantMessageId: "assistant-atomic-new-turn",
        assistantDate: "2026-03-08T00:01:00.000Z",
      }) as any,
    );

    expect(job.state).toBe("queued");
    expect(canceled.map((row) => row.op_id)).toEqual([recovery.op_id]);
    expect(getAcpJobByOpId(recovery.op_id)).toMatchObject({
      state: "canceled",
      error: "superseded by a newer user turn",
    });
  });

  it("does not cancel recovery when the original user enqueue is redelivered", () => {
    const request = makeRequest({
      userMessageId: "user-redelivered",
      assistantMessageId: "assistant-redelivered",
      assistantDate: "2026-03-08T00:00:00.000Z",
    }) as any;
    const original = enqueueAcpJob(request);
    const recovery = enqueueAcpJob(
      {
        ...makeRequest({
          userMessageId: "user-redelivery-recovery",
          assistantMessageId: "assistant-redelivery-recovery",
          assistantDate: "2026-03-08T00:01:00.000Z",
        }),
        recovery_parent_op_id: original.op_id,
        recovery_reason: "lost turn",
        recovery_count: 1,
      } as any,
      { available_at: Date.now() + 15 * 60_000 },
    );

    const result = enqueueAcpJobCancelingQueuedRecoveries(request);

    expect(result.job.op_id).toBe(original.op_id);
    expect(result.canceled).toEqual([]);
    expect(getAcpJobByOpId(recovery.op_id)?.state).toBe("queued");
  });

  it("cancels queued recovery jobs when a user turn supersedes them", () => {
    const request = {
      ...makeRequest({
        userMessageId: "user-canceled-recovery",
        assistantMessageId: "assistant-canceled-recovery",
        assistantDate: "2026-03-08T00:00:00.000Z",
      }),
      recovery_parent_op_id: "parent-canceled-recovery",
      recovery_reason: "model capacity",
      recovery_count: 1,
    };
    const queued = enqueueAcpJob(request as any, {
      available_at: Date.now() + 15 * 60_000,
    });

    const canceled = cancelQueuedRecoveryJobsForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
    });

    expect(canceled.map((row) => row.op_id)).toEqual([queued.op_id]);
    expect(getAcpJobByOpId(queued.op_id)).toMatchObject({
      state: "canceled",
      error: "superseded by a newer user turn",
    });
  });

  it("reserves a continuation for its retained runtime worker", () => {
    const queued = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-affinity-1",
        assistantMessageId: "assistant-affinity-1",
        assistantDate: "2026-03-08T00:00:00.000Z",
      }),
      { preferred_worker_id: "worker-old" },
    );

    expect(queued.worker_id).toBe("worker-old");
    expect(
      claimNextQueuedAcpJobForThread({
        project_id: queued.project_id,
        path: queued.path,
        thread_id: queued.thread_id,
        worker_id: "worker-new",
      }),
    ).toBeUndefined();

    const claimed = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-old",
      worker_bundle_version: "bundle-old",
    });
    expect(claimed?.op_id).toBe(queued.op_id);
    expect(claimed?.worker_id).toBe("worker-old");
  });

  it("can release stale continuation affinity without replacing the job", () => {
    const queued = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-affinity-2",
        assistantMessageId: "assistant-affinity-2",
        assistantDate: "2026-03-08T00:00:00.000Z",
      }),
      { preferred_worker_id: "worker-dead" },
    );

    expect(
      clearQueuedAcpJobWorkerAffinity({
        op_id: queued.op_id,
        worker_id: "worker-other",
      }),
    ).toBe(false);
    expect(
      clearQueuedAcpJobWorkerAffinity({
        op_id: queued.op_id,
        worker_id: "worker-dead",
      }),
    ).toBe(true);

    const claimed = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
      worker_id: "worker-new",
    });
    expect(claimed?.op_id).toBe(queued.op_id);
    expect(claimed?.worker_id).toBe("worker-new");
  });

  it("keeps normal queued turns in FIFO order", async () => {
    const older = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        assistantDate: "2026-03-08T00:00:01.000Z",
      }),
    );
    await delay();
    const newer = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-2",
        assistantMessageId: "assistant-2",
        assistantDate: "2026-03-08T00:00:02.000Z",
      }),
    );
    const queued = listQueuedAcpJobsForThread({
      project_id: older.project_id,
      path: older.path,
      thread_id: older.thread_id,
    });
    expect(queued.map((row) => row.op_id)).toEqual([older.op_id, newer.op_id]);

    const first = claimNextQueuedAcpJobForThread({
      project_id: older.project_id,
      path: older.path,
      thread_id: older.thread_id,
    });
    expect(first?.op_id).toBe(older.op_id);
  });

  it("still lets send immediately jump ahead of normal queued turns", async () => {
    const older = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        assistantDate: "2026-03-08T00:00:01.000Z",
      }),
    );
    await delay();
    const newer = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-2",
        assistantMessageId: "assistant-2",
        assistantDate: "2026-03-08T00:00:02.000Z",
      }),
    );

    reprioritizeAcpJobImmediate({
      project_id: newer.project_id,
      path: newer.path,
      user_message_id: newer.user_message_id,
      account_id: newer.account_id!,
      thread_id: newer.thread_id,
    });

    const queued = listQueuedAcpJobsForThread({
      project_id: older.project_id,
      path: older.path,
      thread_id: older.thread_id,
    });
    expect(queued.map((row) => row.op_id)).toEqual([newer.op_id, older.op_id]);

    const first = claimNextQueuedAcpJobForThread({
      project_id: older.project_id,
      path: older.path,
      thread_id: older.thread_id,
    });
    expect(first?.op_id).toBe(newer.op_id);
  });

  it("does not claim a second queued job while the thread already has a running owner", async () => {
    const first = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        assistantDate: "2026-03-08T00:00:01.000Z",
      }),
    );
    await delay();
    const second = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-2",
        assistantMessageId: "assistant-2",
        assistantDate: "2026-03-08T00:00:02.000Z",
      }),
    );

    const running = claimNextQueuedAcpJobForThread({
      project_id: first.project_id,
      path: first.path,
      thread_id: first.thread_id,
      worker_id: "worker-a",
      worker_bundle_version: "bundle-a",
    });
    expect(running?.op_id).toBe(first.op_id);
    expect(running?.worker_id).toBe("worker-a");
    expect(countRunningAcpJobsForWorker("worker-a")).toBe(1);

    const blocked = claimNextQueuedAcpJobForThread({
      project_id: second.project_id,
      path: second.path,
      thread_id: second.thread_id,
      worker_id: "worker-b",
      worker_bundle_version: "bundle-b",
    });
    expect(blocked).toBeUndefined();

    setAcpJobState({
      op_id: first.op_id,
      state: "completed",
      worker_id: "worker-a",
    });

    const afterFinish = claimNextQueuedAcpJobForThread({
      project_id: second.project_id,
      path: second.path,
      thread_id: second.thread_id,
      worker_id: "worker-b",
      worker_bundle_version: "bundle-b",
    });
    expect(afterFinish?.op_id).toBe(second.op_id);
    expect(afterFinish?.worker_id).toBe("worker-b");
  });

  it("measures queued backlog without counting a long-running job", async () => {
    const first = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        assistantDate: "2026-03-08T00:00:01.000Z",
      }),
    );
    await delay();
    const second = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-2",
        assistantMessageId: "assistant-2",
        assistantDate: "2026-03-08T00:00:02.000Z",
      }),
    );

    claimNextQueuedAcpJobForThread({
      project_id: first.project_id,
      path: first.path,
      thread_id: first.thread_id,
      worker_id: "worker-a",
    });

    expect(oldestQueuedAcpJobTimestamp()).toBe(second.updated_at);
  });

  it("stores account identity and counts queued/running/created jobs cheaply", async () => {
    const first = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-count-1",
        assistantMessageId: "assistant-count-1",
        assistantDate: "2026-03-08T00:00:05.000Z",
      }),
    );
    await delay();
    const second = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-count-2",
        assistantMessageId: "assistant-count-2",
        assistantDate: "2026-03-08T00:00:06.000Z",
      }),
    );

    expect(first.account_id).toBe("00000000-1000-4000-8000-000000000001");
    expect(countQueuedAcpJobsForAccount(first.account_id!)).toBe(2);
    expect(
      countQueuedAcpJobsForThread({
        project_id: first.project_id,
        path: first.path,
        thread_id: first.thread_id,
      }),
    ).toBe(2);
    expect(
      countCreatedAcpJobsForAccountSince({
        account_id: first.account_id!,
        since: Date.now() - 60_000,
      }),
    ).toBe(2);

    claimNextQueuedAcpJobForThread({
      project_id: first.project_id,
      path: first.path,
      thread_id: first.thread_id,
    });
    expect(countRunningAcpJobsForAccount(first.account_id!)).toBe(1);
    expect(countRunningAcpJobsForProject(first.project_id)).toBe(1);
    expect(countQueuedAcpJobsForAccount(second.account_id!)).toBe(1);
  });

  it("does not count recovery continuations as new created-turn usage", () => {
    const parent = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-created-parent",
        assistantMessageId: "assistant-created-parent",
        assistantDate: "2026-03-08T00:00:07.000Z",
      }),
    );
    enqueueAcpJob({
      ...makeRequest({
        userMessageId: "user-created-recovery",
        assistantMessageId: "assistant-created-recovery",
        assistantDate: "2026-03-08T00:00:08.000Z",
      }),
      recovery_parent_op_id: parent.op_id,
      recovery_reason: "server restart",
      recovery_count: 1,
    });

    expect(
      countCreatedAcpJobsForAccountSince({
        account_id: parent.account_id!,
        since: Date.now() - 60_000,
      }),
    ).toBe(1);
    expect(
      countCreatedAcpJobsForAccountSince({
        account_id: parent.account_id!,
        since: Date.now() - 60_000,
        includeRecovery: true,
      }),
    ).toBe(2);
  });

  it("does not claim a job when account or project running caps are reached", async () => {
    const first = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-cap-1",
        assistantMessageId: "assistant-cap-1",
        assistantDate: "2026-03-08T00:00:09.000Z",
      }),
    );
    const running = claimNextQueuedAcpJobForThread({
      project_id: first.project_id,
      path: first.path,
      thread_id: first.thread_id,
    });
    expect(running?.op_id).toBe(first.op_id);

    const second = enqueueAcpJob({
      ...makeRequest({
        userMessageId: "user-cap-2",
        assistantMessageId: "assistant-cap-2",
        assistantDate: "2026-03-08T00:00:10.000Z",
      }),
      chat: {
        ...makeRequest({
          userMessageId: "user-cap-2",
          assistantMessageId: "assistant-cap-2",
          assistantDate: "2026-03-08T00:00:10.000Z",
        }).chat,
        thread_id: "thread-2",
      },
    });
    expect(
      claimNextQueuedAcpJobForThread({
        project_id: second.project_id,
        path: second.path,
        thread_id: second.thread_id,
        max_running_for_account: 1,
      }),
    ).toBeUndefined();
    expect(
      claimNextQueuedAcpJobForThread({
        project_id: second.project_id,
        path: second.path,
        thread_id: second.thread_id,
        max_running_for_project: 1,
      }),
    ).toBeUndefined();
  });

  it("denies new job creation before insert when local queue caps are reached", () => {
    const firstRequest = makeRequest({
      userMessageId: "user-admit-1",
      assistantMessageId: "assistant-admit-1",
      assistantDate: "2026-03-08T00:00:11.000Z",
    });
    enqueueAcpJob(firstRequest);
    const secondRequest = makeRequest({
      userMessageId: "user-admit-2",
      assistantMessageId: "assistant-admit-2",
      assistantDate: "2026-03-08T00:00:12.000Z",
    });

    const decision = admitAcpJobCreation(secondRequest, {
      queuedPerAccount: 1,
      queuedPerThread: 100,
      created5hPerAccount: 100,
      created7dPerAccount: 100,
      runningPerAccount: 100,
      runningPerProject: 100,
    });
    expect(decision).toMatchObject({
      ok: false,
      limit: "queued_per_account",
      current: 1,
      maximum: 1,
    });
    expect(() => throwIfAcpAdmissionDenied(decision)).toThrow(
      "ACP turn limit reached",
    );
    expect(countQueuedAcpJobsForAccount(firstRequest.account_id)).toBe(1);
  });

  it("denies new job creation before insert when thread or created caps are reached", () => {
    const firstRequest = makeRequest({
      userMessageId: "user-admit-thread-1",
      assistantMessageId: "assistant-admit-thread-1",
      assistantDate: "2026-03-08T00:00:11.100Z",
    });
    enqueueAcpJob(firstRequest);
    const secondRequest = makeRequest({
      userMessageId: "user-admit-thread-2",
      assistantMessageId: "assistant-admit-thread-2",
      assistantDate: "2026-03-08T00:00:11.200Z",
    });

    expect(
      admitAcpJobCreation(secondRequest, {
        queuedPerAccount: 100,
        queuedPerThread: 1,
        created5hPerAccount: 100,
        created7dPerAccount: 100,
        runningPerAccount: 100,
        runningPerProject: 100,
      }),
    ).toMatchObject({
      ok: false,
      limit: "queued_per_thread",
      current: 1,
      maximum: 1,
      path: firstRequest.chat.path,
      thread_id: firstRequest.chat.thread_id,
    });

    expect(
      admitAcpJobCreation(secondRequest, {
        queuedPerAccount: 100,
        queuedPerThread: 100,
        created5hPerAccount: 1,
        created7dPerAccount: 100,
        runningPerAccount: 100,
        runningPerProject: 100,
      }),
    ).toMatchObject({
      ok: false,
      limit: "created_5h_per_account",
      current: 1,
      maximum: 1,
    });

    expect(
      admitAcpJobCreation(secondRequest, {
        queuedPerAccount: 100,
        queuedPerThread: 100,
        created5hPerAccount: 100,
        created7dPerAccount: 1,
        runningPerAccount: 100,
        runningPerProject: 100,
      }),
    ).toMatchObject({
      ok: false,
      limit: "created_7d_per_account",
      current: 1,
      maximum: 1,
    });
  });

  it("denies running admission when account or project caps are reached", () => {
    const first = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-exec-admit-1",
        assistantMessageId: "assistant-exec-admit-1",
        assistantDate: "2026-03-08T00:00:11.300Z",
      }),
    );
    claimNextQueuedAcpJobForThread({
      project_id: first.project_id,
      path: first.path,
      thread_id: first.thread_id,
    });
    const second = enqueueAcpJob({
      ...makeRequest({
        userMessageId: "user-exec-admit-2",
        assistantMessageId: "assistant-exec-admit-2",
        assistantDate: "2026-03-08T00:00:11.400Z",
      }),
      chat: {
        ...makeRequest({
          userMessageId: "user-exec-admit-2",
          assistantMessageId: "assistant-exec-admit-2",
          assistantDate: "2026-03-08T00:00:11.400Z",
        }).chat,
        thread_id: "thread-exec-admit-2",
      },
    });

    expect(
      admitAcpJobExecution(second, {
        queuedPerAccount: 100,
        queuedPerThread: 100,
        created5hPerAccount: 100,
        created7dPerAccount: 100,
        runningPerAccount: 100,
        runningPerProject: 1,
      }),
    ).toMatchObject({
      ok: false,
      limit: "running_per_project",
      current: 1,
      maximum: 1,
    });

    expect(
      admitAcpJobExecution(second, {
        queuedPerAccount: 100,
        queuedPerThread: 100,
        created5hPerAccount: 100,
        created7dPerAccount: 100,
        runningPerAccount: 1,
        runningPerProject: 100,
      }),
    ).toMatchObject({
      ok: false,
      limit: "running_per_account",
      current: 1,
      maximum: 1,
    });
  });

  it("records ACP admission denials before throwing", async () => {
    const events: AcpAdmissionDenialEvent[] = [];
    setAcpAdmissionDenialRecorder((event) => {
      events.push(event);
    });
    const decision = {
      ok: false as const,
      limit: "running_per_account" as const,
      current: 2,
      maximum: 2,
      account_id: "00000000-1000-4000-8000-000000000001",
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/tmp/acp.chat",
      thread_id: "thread-1",
    };

    expect(() => throwIfAcpAdmissionDenied(decision, "claim")).toThrow(
      "ACP turn limit reached",
    );
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ...decision,
      source: "claim",
    });
    expect(events[0].time).toBeGreaterThan(0);
  });

  it("allows recovery continuation creation through local queue caps", () => {
    const parent = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-admit-recovery-parent",
        assistantMessageId: "assistant-admit-recovery-parent",
        assistantDate: "2026-03-08T00:00:13.000Z",
      }),
    );
    const recoveryRequest = {
      ...makeRequest({
        userMessageId: "user-admit-recovery",
        assistantMessageId: "assistant-admit-recovery",
        assistantDate: "2026-03-08T00:00:14.000Z",
      }),
      recovery_parent_op_id: parent.op_id,
      recovery_reason: "server restart",
      recovery_count: 1,
    };

    expect(
      admitAcpJobCreation(recoveryRequest, {
        queuedPerAccount: 0,
        queuedPerThread: 0,
        created5hPerAccount: 0,
        created7dPerAccount: 0,
        runningPerAccount: 0,
        runningPerProject: 0,
      }),
    ).toEqual({ ok: true });
  });

  it("does not take recovery lineage from a submitted turn", () => {
    const base = makeRequest({
      userMessageId: "user-submitted-lineage",
      assistantMessageId: "assistant-submitted-lineage",
      assistantDate: "2026-03-08T00:00:14.050Z",
    });
    const submitted = {
      ...base,
      recovery_parent_op_id: "some-op",
      recovery_reason: "server restart",
      recovery_count: 1,
      chat: {
        ...base.chat!,
        recovery_parent_op_id: "some-op",
        recovery_reason: "server restart",
        recovery_count: 1,
      },
    };
    const request = withoutRecoveryLineage(submitted);
    expect(request).not.toHaveProperty("recovery_parent_op_id");
    expect(request).not.toHaveProperty("recovery_count");
    expect(request.chat).not.toHaveProperty("recovery_parent_op_id");
    expect(request.chat).not.toHaveProperty("recovery_reason");
    expect(request.chat!.thread_id).toBe(base.chat!.thread_id);
    expect(
      admitAcpJobCreation(request, {
        queuedPerAccount: 0,
        queuedPerThread: 0,
        created5hPerAccount: 0,
        created7dPerAccount: 0,
        runningPerAccount: 0,
        runningPerProject: 0,
      }),
    ).toMatchObject({ ok: false });
  });

  it("admits a human turn that atomically supersedes a queued recovery", () => {
    const recoveryRequest = {
      ...makeRequest({
        userMessageId: "user-delayed-recovery-admission",
        assistantMessageId: "assistant-delayed-recovery-admission",
        assistantDate: "2026-03-08T00:00:14.100Z",
      }),
      recovery_parent_op_id: "failed-parent-admission",
      recovery_reason: "model capacity",
      recovery_count: 1,
    };
    enqueueAcpJob(recoveryRequest, {
      available_at: Date.now() + 15 * 60_000,
    });
    const humanRequest = makeRequest({
      userMessageId: "user-superseding-recovery",
      assistantMessageId: "assistant-superseding-recovery",
      assistantDate: "2026-03-08T00:00:14.200Z",
    });
    const limits = {
      queuedPerAccount: 1,
      queuedPerThread: 1,
      created5hPerAccount: 100,
      created7dPerAccount: 100,
      runningPerAccount: 100,
      runningPerProject: 100,
    };

    expect(admitAcpJobCreation(humanRequest, limits)).toMatchObject({
      ok: false,
      limit: "queued_per_account",
    });
    expect(
      admitAcpJobCreation(humanRequest, limits, Date.now(), {
        supersedesQueuedRecoveries: true,
      }),
    ).toEqual({ ok: true });
  });

  it("maps membership effective limits into ACP admission limits", () => {
    const defaults = {
      queuedPerAccount: 1000,
      queuedPerThread: 100,
      created5hPerAccount: 500,
      created7dPerAccount: 2000,
      runningPerAccount: 50,
      runningPerProject: 50,
    };

    expect(
      mergeAcpAdmissionLimits(
        defaults,
        acpAdmissionLimitsFromEffectiveLimits({
          acp_max_queued_per_account: 12,
          acp_max_queued_per_thread: 3,
          acp_max_created_5h_per_account: 20,
          acp_max_created_7d_per_account: 70,
          acp_max_running_per_account: 4,
          acp_max_running_per_project: 2,
          acp_max_active_automations_per_project: 3,
        }),
      ),
    ).toEqual({
      queuedPerAccount: 12,
      queuedPerThread: 3,
      created5hPerAccount: 20,
      created7dPerAccount: 70,
      runningPerAccount: 4,
      runningPerProject: 2,
    });
  });

  it("stores recovery metadata for resumed codex turns", () => {
    const job = enqueueAcpJob({
      ...makeRequest({
        userMessageId: "user-recovery-1",
        assistantMessageId: "assistant-recovery-1",
        assistantDate: "2026-03-08T00:00:03.500Z",
      }),
      recovery_parent_op_id: "assistant-parent-1",
      recovery_reason: "backend server restarted",
      recovery_count: 2,
    });
    expect(job.recovery_parent_op_id).toBe("assistant-parent-1");
    expect(job.recovery_reason).toBe("backend server restarted");
    expect(job.recovery_count).toBe(2);
    expect(getAcpJobByOpId(job.op_id)?.recovery_count).toBe(2);
    expect(
      listAcpJobsByRecoveryParent({
        recovery_parent_op_id: "assistant-parent-1",
      }).map((row) => row.op_id),
    ).toEqual([job.op_id]);
    expect(decodeAcpJobRequest(job)).toEqual(
      expect.objectContaining({
        recovery_parent_op_id: "assistant-parent-1",
        recovery_reason: "backend server restarted",
        recovery_count: 2,
      }),
    );
  });

  it("durably stores and clears terminal recovery intent", () => {
    const job = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-terminal-recovery-intent",
        assistantMessageId: "assistant-terminal-recovery-intent",
        assistantDate: "2026-03-08T00:00:03.600Z",
      }),
    );

    setAcpJobState({
      op_id: job.op_id,
      state: "error",
      error: "Codex app-server exited",
      recovery_code: "codex_app_server_exited",
      recovery_detail: "exit code 137",
    });

    expect(listAcpJobsWithRecoveryIntent()).toEqual([
      expect.objectContaining({
        op_id: job.op_id,
        state: "error",
        recovery_code: "codex_app_server_exited",
        recovery_detail: "exit code 137",
      }),
    ]);
    clearAcpJobRecoveryIntent(job.op_id);
    expect(listAcpJobsWithRecoveryIntent()).toEqual([]);
    expect(getAcpJobByOpId(job.op_id)).toMatchObject({
      recovery_code: null,
      recovery_detail: null,
    });
  });

  it("can resend a canceled queued job", async () => {
    const queued = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-resend-1",
        assistantMessageId: "assistant-resend-1",
        assistantDate: "2026-03-08T00:00:04.000Z",
      }),
    );
    const canceled = cancelQueuedAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
      account_id: queued.account_id!,
      thread_id: queued.thread_id,
    });
    expect(canceled?.state).toBe("canceled");

    const resent = resendCanceledAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
      account_id: queued.account_id!,
      thread_id: queued.thread_id,
    });
    expect(resent?.state).toBe("queued");

    const claimed = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
    });
    expect(claimed?.op_id).toBe(queued.op_id);
  });

  function rejectedModelJob(
    error = "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    paymentSource: "auto" | "subscription" | "account-api-key" = "auto",
  ) {
    const request = {
      ...makeRequest({
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        assistantDate: new Date().toISOString(),
      }),
      prompt: "Visible request\nHidden file context and attachment references",
      config: {
        model: "gpt-5.6-sol",
        paymentSource,
        reasoning: "ultra" as const,
        serviceTier: "fast" as const,
        workingDirectory: "/tmp",
        sessionMode: "workspace-write" as const,
      },
    };
    const job = enqueueAcpJob(request);
    setAcpJobState({ op_id: job.op_id, state: "error", error });
    return {
      request,
      job,
      options: {
        project_id: job.project_id,
        path: job.path,
        user_message_id: job.user_message_id,
        account_id: job.account_id!,
        thread_id: job.thread_id,
        modelRecovery: {
          account_id: request.account_id,
          thread_id: job.thread_id,
          model: "gpt-5.6-terra",
          expected_model: "gpt-5.6-sol",
        },
      },
    };
  }

  it("atomically retries a model rejection preserving original prompt, session and permissions", () => {
    const { request, options } = rejectedModelJob();
    const retried = resendCanceledAcpJob(options)!;
    expect(retried.state).toBe("queued");
    expect(decodeAcpJobRequest(retried)).toEqual({
      ...request,
      request_kind: "codex",
      config: {
        ...request.config,
        model: "gpt-5.6-terra",
        paymentSource: "subscription",
        reasoning: undefined,
        serviceTier: "standard",
      },
    });
    expect(resendCanceledAcpJob(options)).toBeUndefined();
  });

  it("retries a failed job with only its funding changed", () => {
    const { job, request } = rejectedModelJob(
      "ChatGPT usage limit reached",
      "subscription",
    );
    const replacement = {
      ...request,
      config: {
        ...request.config,
        paymentSource: "subscription-credential" as const,
        credentialId: "new-subscription",
      },
    };
    const options = {
      project_id: job.project_id,
      path: job.path,
      user_message_id: job.user_message_id,
      account_id: job.account_id!,
      thread_id: job.thread_id,
      fundingRecovery: {
        account_id: request.account_id,
        thread_id: job.thread_id,
        expected_request: job.request_json,
        payment_source: replacement.config.paymentSource,
        credential_id: replacement.config.credentialId,
      },
    };
    const retried = resendCanceledAcpJob(options);
    expect(retried?.state).toBe("queued");
    expect(decodeAcpJobRequest(retried!)).toEqual({
      ...request,
      request_kind: "codex",
      config: replacement.config,
    });
    expect(resendCanceledAcpJob(options)).toBeUndefined();
  });

  it("does not replace funding for another account or a changed job", () => {
    const { job, request } = rejectedModelJob("ChatGPT usage limit reached");
    const options = {
      project_id: job.project_id,
      path: job.path,
      user_message_id: job.user_message_id,
      account_id: job.account_id!,
      thread_id: job.thread_id,
      fundingRecovery: {
        account_id: request.account_id,
        thread_id: job.thread_id,
        expected_request: job.request_json,
        payment_source: "account-api-key" as const,
      },
    };
    expect(
      resendCanceledAcpJob({
        ...options,
        fundingRecovery: { ...options.fundingRecovery, account_id: "other" },
      }),
    ).toBeUndefined();
    expect(
      resendCanceledAcpJob({
        ...options,
        fundingRecovery: {
          ...options.fundingRecovery,
          expected_request: "stale",
        },
      }),
    ).toBeUndefined();
    expect(getAcpJobByOpId(job.op_id)?.state).toBe("error");
  });

  it.each(["account_id", "thread_id", "expected_model"])(
    "rejects stale or mismatched recovery %s",
    (key) => {
      const { job, options } = rejectedModelJob();
      expect(
        resendCanceledAcpJob({
          ...options,
          modelRecovery: { ...options.modelRecovery, [key]: "different" },
        }),
      ).toBeUndefined();
      expect(getAcpJobByOpId(job.op_id)?.state).toBe("error");
      expect(getAcpJobByOpId(job.op_id)?.request_json).toBe(job.request_json);
    },
  );

  it.each(["gpt-5.6-sol", "", "invalid model"])(
    "rejects invalid replacement %s",
    (model) => {
      const { options } = rejectedModelJob();
      expect(
        resendCanceledAcpJob({
          ...options,
          modelRecovery: { ...options.modelRecovery, model },
        }),
      ).toBeUndefined();
    },
  );

  it.each(["running", "queued", "completed", "canceled"] as const)(
    "never model-retries a %s job",
    (state) => {
      const { job, options } = rejectedModelJob();
      setAcpJobState({ op_id: job.op_id, state });
      expect(resendCanceledAcpJob(options)).toBeUndefined();
    },
  );

  it("does not model-retry an arbitrary failure", () => {
    const { options } = rejectedModelJob("HTTP 429 rate limit");
    expect(resendCanceledAcpJob(options)).toBeUndefined();
  });

  it("does not rewrite an explicitly API-funded request", () => {
    const { options } = rejectedModelJob(undefined, "account-api-key");
    expect(resendCanceledAcpJob(options)).toBeUndefined();
  });

  it("cancels, resends or reprioritizes only the sender's own turn in its thread", () => {
    const queued = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-owner-only",
        assistantMessageId: "assistant-owner-only",
        assistantDate: "2026-03-08T00:00:20.000Z",
      }),
    );
    const key = {
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    };
    const owner = {
      account_id: queued.account_id!,
      thread_id: queued.thread_id,
    };
    for (const other of [
      { ...owner, account_id: "00000000-1000-4000-8000-0000000000ff" },
      { ...owner, thread_id: "other-thread" },
    ]) {
      expect(cancelQueuedAcpJob({ ...key, ...other })).toBeUndefined();
      expect(reprioritizeAcpJobImmediate({ ...key, ...other })).toBeUndefined();
    }
    expect(getAcpJobByOpId(queued.op_id)).toMatchObject({
      state: "queued",
      priority: 0,
    });

    expect(cancelQueuedAcpJob({ ...key, ...owner })?.state).toBe("canceled");
    expect(
      resendCanceledAcpJob({
        ...key,
        ...owner,
        account_id: "00000000-1000-4000-8000-0000000000ff",
      }),
    ).toBeUndefined();
    expect(getAcpJobByOpId(queued.op_id)?.state).toBe("canceled");
    expect(resendCanceledAcpJob({ ...key, ...owner })?.state).toBe("queued");
  });

  it("can resend a terminal error job", async () => {
    const queued = enqueueAcpJob(
      makeRequest({
        userMessageId: "user-resend-error-1",
        assistantMessageId: "assistant-resend-error-1",
        assistantDate: "2026-03-08T00:00:05.000Z",
      }),
    );
    setAcpJobState({
      op_id: queued.op_id,
      state: "error",
      error: "Codex authentication expired.",
      recovery_code: "codex_app_server_exited",
      recovery_detail: "exit code 137",
    });
    const failed = getAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    });
    expect(failed?.state).toBe("error");

    const resent = resendCanceledAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
      account_id: queued.account_id!,
      thread_id: queued.thread_id,
    });
    expect(resent?.state).toBe("queued");
    expect(resent).toMatchObject({
      recovery_code: null,
      recovery_detail: null,
    });
    expect(listAcpJobsWithRecoveryIntent()).toEqual([]);

    const claimed = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
    });
    expect(claimed?.op_id).toBe(queued.op_id);
    setAcpJobState({
      op_id: queued.op_id,
      state: "error",
      error: "The manual retry failed without a recoverable condition.",
    });
    expect(listAcpJobsWithRecoveryIntent()).toEqual([]);
  });
});
