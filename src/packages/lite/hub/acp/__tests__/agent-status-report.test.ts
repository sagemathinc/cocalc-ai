import { randomUUID } from "node:crypto";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import { enqueueAcpJob, listQueuedAcpJobs } from "../../sqlite/acp-jobs";
import {
  remember,
  setAgentStatusReporterForTests,
  sweepAgentStatus,
} from "../agent-status-report";

const ACCOUNT = "00000000-1000-4000-8000-000000000001";
const PROJECT = "00000000-1000-4000-8000-000000000000";

function job(path = "/tmp/a.chat", thread_id = "thread-1") {
  return enqueueAcpJob({
    project_id: PROJECT,
    account_id: ACCOUNT,
    session_id: randomUUID(),
    prompt: "hi",
    config: { workingDirectory: "/tmp" },
    chat: {
      project_id: PROJECT,
      path,
      thread_id,
      parent_message_id: randomUUID(),
      message_id: randomUUID(),
      message_date: new Date().toISOString(),
      sender_id: "openai-codex-agent",
    },
  } as any);
}

const set = (op_id: string, fields: Record<string, unknown>) => {
  const keys = Object.keys(fields);
  getAcpDatabase()
    .prepare(
      `UPDATE acp_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE op_id = ?`,
    )
    .run(
      ...keys.map((k) =>
        typeof fields[k] === "object" && fields[k] !== null
          ? JSON.stringify(fields[k])
          : (fields[k] as any),
      ),
      op_id,
    );
};

let reports: any[] = [];
let registered = true;

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
  listQueuedAcpJobs();
});
beforeEach(() => {
  getAcpDatabase().prepare("DELETE FROM acp_jobs").run();
  reports = [];
  registered = true;
  setAgentStatusReporterForTests(async (opts) => {
    reports.push(opts);
    return { registered };
  });
});
afterAll(() => {
  setAgentStatusReporterForTests();
  closeAcpDatabase();
});

describe("reporting what each agent is doing", () => {
  it("reports a change once, and the next change", async () => {
    const now = Date.now();
    const mine = job();
    await sweepAgentStatus(now);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      account_id: ACCOUNT,
      project_id: PROJECT,
      path: "/tmp/a.chat",
      thread_id: "thread-1",
      status: { running: 0, queued: 1 },
    });
    // Nothing changed: nothing sent.
    set(mine.op_id, { updated_at: now + 1 });
    await sweepAgentStatus(now + 10_000);
    expect(reports).toHaveLength(1);
    // It hit its usage limit.
    const resets_at = now + 3_600_000;
    set(mine.op_id, {
      state: "error",
      started_at: now + 2,
      finished_at: now + 20_000,
      updated_at: now + 20_000,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: {
          kind: "limit",
          scope: "credential",
          credential_id: "11111111-1111-4111-8111-111111111111",
          resets_at,
        },
      },
    });
    await sweepAgentStatus(now + 30_000);
    expect(reports).toHaveLength(2);
    expect(reports[1].status).toMatchObject({
      running: 0,
      queued: 0,
      by_account: { [ACCOUNT]: { reason: "limit", until: resets_at } },
      last: { state: "failed", kind: "limit" },
    });
    expect(JSON.stringify(reports[1])).not.toMatch(/credential/);
  });

  it("stops asking about a conversation that isn't a registered agent", async () => {
    const now = Date.now();
    registered = false;
    const mine = job();
    await sweepAgentStatus(now);
    expect(reports).toHaveLength(1);
    set(mine.op_id, { state: "running", updated_at: now + 20_000 });
    await sweepAgentStatus(now + 30_000);
    expect(reports).toHaveLength(1);
  });

  it("asks again after an hour, even if nothing changed (it may be registered now)", async () => {
    const now = Date.now();
    registered = false;
    job();
    await sweepAgentStatus(now);
    expect(reports).toHaveLength(1);
    registered = true;
    // Within the hour: not asked.
    await sweepAgentStatus(now + 30 * 60_000);
    expect(reports).toHaveLength(1);
    // After it: asked, with the same (unchanged) status.
    await sweepAgentStatus(now + 61 * 60_000);
    expect(reports).toHaveLength(2);
    expect(reports[1].status).toEqual({
      ...reports[0].status,
      at: now + 61 * 60_000,
    });
    // Registered now: reported like any agent, only on change.
    await sweepAgentStatus(now + 62 * 60_000);
    expect(reports).toHaveLength(2);
  });

  it("only chats have agents", async () => {
    job("/tmp/notes.term");
    await sweepAgentStatus(Date.now());
    expect(reports).toHaveLength(0);
  });

  it("a failed report is tried again at the next change", async () => {
    const now = Date.now();
    let fail = true;
    setAgentStatusReporterForTests(async (opts) => {
      if (fail) throw new Error("hub unreachable");
      reports.push(opts);
      return { registered: true };
    });
    const mine = job();
    await sweepAgentStatus(now);
    fail = false;
    set(mine.op_id, { state: "running", updated_at: now + 20_000 });
    await sweepAgentStatus(now + 30_000);
    expect(reports).toHaveLength(1);
    expect(reports[0].status).toMatchObject({ running: 1, queued: 0 });
  });
});

describe("a failed report with no later change", () => {
  it("is tried again with backoff, and stops once it is sent", async () => {
    const now = Date.now();
    let fail = true;
    let attempts = 0;
    setAgentStatusReporterForTests(async (opts) => {
      attempts += 1;
      if (fail) throw new Error("hub unreachable");
      reports.push(opts);
      return { registered: true };
    });
    // A turn that ended at its limit: its job never changes again.
    const mine = job();
    set(mine.op_id, {
      state: "error",
      started_at: now - 61_000,
      finished_at: now - 60_000,
      updated_at: now - 60_000,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: {
          kind: "limit",
          scope: "credential",
          resets_at: now + 3_600_000,
        },
      },
    });
    await sweepAgentStatus(now);
    expect(attempts).toBe(1);
    // Not due yet (30 s): not tried.
    await sweepAgentStatus(now + 10_000);
    expect(attempts).toBe(1);
    // Due: tried again, and fails again; the next wait is a minute.
    await sweepAgentStatus(now + 31_000);
    expect(attempts).toBe(2);
    await sweepAgentStatus(now + 61_000);
    expect(attempts).toBe(2);
    fail = false;
    await sweepAgentStatus(now + 92_000);
    expect(attempts).toBe(3);
    expect(reports).toHaveLength(1);
    expect(reports[0].status).toMatchObject({
      by_account: { [ACCOUNT]: { reason: "limit" } },
    });
    // Sent: nothing more.
    await sweepAgentStatus(now + 30 * 60_000);
    expect(attempts).toBe(3);
  });
});

describe("an unchanged status that is still true", () => {
  it("is sent again before it expires, and only while it says something", async () => {
    const now = Date.now();
    const mine = job();
    set(mine.op_id, {
      state: "error",
      started_at: now - 61_000,
      finished_at: now - 60_000,
      updated_at: now - 60_000,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "sign-in" },
      },
    });
    await sweepAgentStatus(now);
    expect(reports).toHaveLength(1);
    expect(reports[0].status.by_account[ACCOUNT]).toMatchObject({
      reason: "sign-in",
    });
    // Nothing changes for hours: not sent again until the refresh is due.
    await sweepAgentStatus(now + 60 * 60_000);
    expect(reports).toHaveLength(1);
    await sweepAgentStatus(now + 6 * 60 * 60_000 + 1);
    expect(reports).toHaveLength(2);
    expect(reports[1].status).toMatchObject({
      by_account: { [ACCOUNT]: { reason: "sign-in" } },
      at: now + 6 * 60 * 60_000 + 1,
    });
  });

  it("an idle agent is not refreshed", async () => {
    const now = Date.now();
    const mine = job();
    set(mine.op_id, {
      state: "completed",
      started_at: now - 61_000,
      finished_at: now - 60_000,
      updated_at: now - 60_000,
      outcome_json: { version: 1, state: "completed" },
    });
    await sweepAgentStatus(now);
    expect(reports).toHaveLength(1);
    await sweepAgentStatus(now + 7 * 60 * 60_000);
    expect(reports).toHaveLength(1);
  });

  it("an hourly recheck of an unregistered agent waits out a failure's backoff", async () => {
    const now = Date.now();
    let fail = false;
    let attempts = 0;
    setAgentStatusReporterForTests(async (opts) => {
      attempts += 1;
      if (fail) throw new Error("hub unreachable");
      reports.push(opts);
      return { registered: false };
    });
    const mine = job();
    set(mine.op_id, { updated_at: now - 60_000 });
    await sweepAgentStatus(now);
    expect(attempts).toBe(1);
    fail = true;
    // The hourly recheck fails: then it backs off (30 s), not every sweep.
    const due = now + 61 * 60_000;
    await sweepAgentStatus(due);
    expect(attempts).toBe(2);
    await sweepAgentStatus(due + 10_000);
    await sweepAgentStatus(due + 20_000);
    expect(attempts).toBe(2);
    await sweepAgentStatus(due + 31_000);
    expect(attempts).toBe(3);
  });
});

describe("limits and sign-ins are per account", () => {
  it("each account's own latest turn says whether it is unavailable", async () => {
    const now = Date.now();
    const other = "00000000-1000-4000-8000-000000000002";
    const mine = job();
    set(mine.op_id, {
      state: "error",
      started_at: now - 61_000,
      finished_at: now - 60_000,
      updated_at: now - 60_000,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "sign-in" },
      },
    });
    // A collaborator's later turn on the same agent succeeded: that says
    // nothing about this account's sign-in.
    const theirs = job();
    set(theirs.op_id, {
      account_id: other,
      state: "completed",
      started_at: now - 31_000,
      finished_at: now - 30_000,
      updated_at: now - 30_000,
      outcome_json: { version: 1, state: "completed" },
    });
    await sweepAgentStatus(now);
    expect(reports).toHaveLength(1);
    expect(reports[0].status.by_account).toEqual({
      [ACCOUNT]: { reason: "sign-in" },
    });
    expect(reports[0].status.unavailable).toBeUndefined();
  });
});

describe("after a restart", () => {
  it("an old status that is still true is sent again, so its refresh resumes", async () => {
    const now = Date.now();
    const blocked = job("/tmp/a.chat", "blocked");
    set(blocked.op_id, {
      state: "error",
      started_at: now - 3 * 60 * 60_000,
      finished_at: now - 3 * 60 * 60_000,
      updated_at: now - 3 * 60 * 60_000,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "sign-in" },
      },
    });
    const idle = job("/tmp/b.chat", "idle");
    set(idle.op_id, {
      state: "completed",
      started_at: now - 3 * 60 * 60_000,
      finished_at: now - 3 * 60 * 60_000,
      updated_at: now - 3 * 60 * 60_000,
      outcome_json: { version: 1, state: "completed" },
    });
    // A fresh process: nothing sent yet.
    await sweepAgentStatus(now);
    expect(reports.map((r) => r.thread_id)).toEqual(["blocked"]);
  });
});

describe("a refresh that keeps failing", () => {
  it("gives up for a while, then tries again at its own interval", async () => {
    const now = Date.now();
    let fail = false;
    let attempts = 0;
    setAgentStatusReporterForTests(async (opts) => {
      attempts += 1;
      if (fail) throw new Error("hub unreachable");
      reports.push(opts);
      return { registered: true };
    });
    const mine = job();
    set(mine.op_id, {
      state: "error",
      started_at: now - 61_000,
      finished_at: now - 60_000,
      updated_at: now - 60_000,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "sign-in" },
      },
    });
    await sweepAgentStatus(now);
    expect(attempts).toBe(1);
    fail = true;
    // The refresh is due and fails: eleven tries with backoff (the cap is
    // ten minutes apart), then it stops.
    let t = now + 6 * 60 * 60_000 + 1;
    for (let i = 0; i < 15; i++) {
      await sweepAgentStatus(t);
      t += 10 * 60_000;
    }
    expect(attempts - 1).toBe(11);
    // Then it waits a full refresh interval, not the next sweep.
    await sweepAgentStatus(t + 60 * 60_000);
    expect(attempts - 1).toBe(11);
    await sweepAgentStatus(t + 7 * 60 * 60_000);
    expect(attempts - 1).toBe(12);
  });
});

describe("bounded memory", () => {
  it("at its cap, forgets only the oldest entry", () => {
    const map = new Map<string, number>();
    for (const key of ["a", "b", "c"]) remember(map, key, 1, 2);
    expect([...map.keys()]).toEqual(["b", "c"]);
    // Updating an entry keeps the others.
    remember(map, "b", 2, 2);
    expect([...map.entries()]).toEqual([
      ["c", 1],
      ["b", 2],
    ]);
  });
});

describe("one account's turn running", () => {
  it("does not hide another account's own block", async () => {
    const now = Date.now();
    const other = "00000000-1000-4000-8000-000000000002";
    const mine = job();
    set(mine.op_id, {
      state: "error",
      started_at: now - 61_000,
      finished_at: now - 60_000,
      updated_at: now - 60_000,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "sign-in" },
      },
    });
    const theirs = job();
    set(theirs.op_id, {
      account_id: other,
      state: "running",
      started_at: now - 10_000,
      updated_at: now - 10_000,
    });
    await sweepAgentStatus(now);
    expect(reports[0].status).toMatchObject({
      running: 1,
      by_account: { [ACCOUNT]: { reason: "sign-in" } },
    });
  });

  it("its own running turn clears its block", async () => {
    const now = Date.now();
    const failed = job();
    set(failed.op_id, {
      state: "error",
      started_at: now - 61_000,
      finished_at: now - 60_000,
      updated_at: now - 60_000,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "sign-in" },
      },
    });
    const again = job();
    set(again.op_id, {
      state: "running",
      started_at: now - 10_000,
      updated_at: now - 10_000,
    });
    await sweepAgentStatus(now);
    expect(reports[0].status.by_account).toBeUndefined();
  });
});
