import { randomUUID } from "node:crypto";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import { enqueueAcpJob, listQueuedAcpJobs } from "../../sqlite/acp-jobs";
import {
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
      unavailable: { reason: "limit", until: resets_at },
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
