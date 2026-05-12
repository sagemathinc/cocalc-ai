#!/usr/bin/env ts-node
import { randomUUID } from "node:crypto";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  acpAdmissionLimitsFromEffectiveLimits,
  admitAcpJobCreation,
  mergeAcpAdmissionLimits,
  setAcpAdmissionDenialRecorder,
  throwIfAcpAdmissionDenied,
  type AcpAdmissionDenialEvent,
} from "../admission";
import {
  claimNextQueuedAcpJobForThread,
  cancelQueuedAcpJob,
  countCreatedAcpJobsForAccountSince,
  countQueuedAcpJobsForAccount,
  countQueuedAcpJobsForThread,
  countRunningAcpJobsForAccount,
  countRunningAcpJobsForProject,
  countRunningAcpJobsForWorker,
  decodeAcpJobRequest,
  enqueueAcpJob,
  getAcpJob,
  getAcpJobByOpId,
  listAcpJobsByRecoveryParent,
  listQueuedAcpJobs,
  listQueuedAcpJobsForThread,
  resendCanceledAcpJob,
  reprioritizeAcpJobImmediate,
  setAcpJobState,
} from "../../sqlite/acp-jobs";

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

describe("acp job queue ordering", () => {
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

  it("round-trips command automation jobs without a codex session id", () => {
    const job = enqueueAcpJob({
      request_kind: "command",
      project_id: "00000000-1000-4000-8000-000000000000",
      account_id: "00000000-1000-4000-8000-000000000001",
      command: "git status --short",
      cwd: "/work/repo",
      timeout_ms: 90_000,
      max_output_bytes: 250_000,
      chat: {
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "/tmp/acp-jobs-order.chat",
        thread_id: "thread-1",
        parent_message_id: "user-command-1",
        message_id: "assistant-command-1",
        message_date: "2026-03-08T00:00:03.000Z",
        sender_id: "openai-codex-agent",
      },
    });
    expect(job.session_id).toBeNull();
    const stored = getAcpJob({
      project_id: job.project_id,
      path: job.path,
      user_message_id: job.user_message_id,
    });
    expect(stored?.session_id).toBeNull();
    expect(stored?.account_id).toBe("00000000-1000-4000-8000-000000000001");
    expect(stored ? decodeAcpJobRequest(stored) : undefined).toEqual({
      request_kind: "command",
      project_id: "00000000-1000-4000-8000-000000000000",
      account_id: "00000000-1000-4000-8000-000000000001",
      command: "git status --short",
      cwd: "/work/repo",
      timeout_ms: 90_000,
      max_output_bytes: 250_000,
      chat: {
        project_id: "00000000-1000-4000-8000-000000000000",
        path: "/tmp/acp-jobs-order.chat",
        thread_id: "thread-1",
        parent_message_id: "user-command-1",
        message_id: "assistant-command-1",
        message_date: "2026-03-08T00:00:03.000Z",
        sender_id: "openai-codex-agent",
      },
    });
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
    });
    expect(canceled?.state).toBe("canceled");

    const resent = resendCanceledAcpJob({
      project_id: queued.project_id,
      path: queued.path,
      user_message_id: queued.user_message_id,
    });
    expect(resent?.state).toBe("queued");

    const claimed = claimNextQueuedAcpJobForThread({
      project_id: queued.project_id,
      path: queued.path,
      thread_id: queued.thread_id,
    });
    expect(claimed?.op_id).toBe(queued.op_id);
  });
});
