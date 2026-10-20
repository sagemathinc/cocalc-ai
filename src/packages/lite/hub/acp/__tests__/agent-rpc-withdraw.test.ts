import { randomUUID } from "node:crypto";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  enqueueAcpJob,
  getAcpJobByOpId,
  listAcpJobsByRecoveryParent,
  listQueuedAcpJobs,
} from "../../sqlite/acp-jobs";
import { listDueAgentRpcReports } from "../../sqlite/agent-rpc-reports";
import { parseTurnOutcome } from "@cocalc/conat/ai/acp/turn-outcome";
import { acpTestInternals, withdrawAgentMessageTurn } from "../index";

jest.mock("@cocalc/chat/server", () => ({
  acquireChatSyncDB: jest.fn(async () => {
    throw new Error("no chat in this test");
  }),
}));

const ACCOUNT = "00000000-1000-4000-8000-000000000001";
const PROJECT = "00000000-1000-4000-8000-000000000000";
const NETWORK = "88888888-8888-4888-8888-888888888888";
const sender = {
  project_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "22222222-2222-4222-8222-222222222222",
};
const target = {
  project_id: PROJECT,
  agent_id: "44444444-4444-4444-8444-444444444444",
};

function job(attempt_id: string) {
  return enqueueAcpJob({
    project_id: PROJECT,
    account_id: ACCOUNT,
    session_id: randomUUID(),
    prompt: "hi",
    config: { workingDirectory: "/tmp" },
    chat: {
      project_id: PROJECT,
      path: "/tmp/withdraw.chat",
      thread_id: "thread-1",
      parent_message_id: randomUUID(),
      message_id: randomUUID(),
      message_date: new Date().toISOString(),
      sender_id: "openai-codex-agent",
      agent_message: true,
      agent_rpc_execution: {
        version: 3,
        source: sender,
        target,
        target_path: "/tmp/withdraw.chat",
        target_thread_id: "thread-1",
        agent_network_id: NETWORK,
        network_generation: "99999999-9999-4999-8999-999999999999",
        account_generation: 1,
        configured_delivery: "queued",
        principal_account_id: ACCOUNT,
        guidance: false,
        attempt_id,
        report_capability: "1791800000000." + "c".repeat(43),
      },
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

const withdraw = (attempt_id: string, source = sender) =>
  withdrawAgentMessageTurn(
    source,
    { version: 3, attempt_id, agent_network_id: NETWORK, target } as any,
    ACCOUNT,
  );

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
  listQueuedAcpJobs();
  listDueAgentRpcReports();
});
beforeEach(() => {
  getAcpDatabase().prepare("DELETE FROM acp_jobs").run();
  getAcpDatabase().prepare("DELETE FROM acp_agent_rpc_reports").run();
});
afterAll(() => closeAcpDatabase());

describe("the sender takes back its message", () => {
  it("while its turn waits: canceled, by the sender, with no report", async () => {
    const attempt = randomUUID();
    const mine = job(attempt);
    const result = await withdraw(attempt);
    expect(result).toMatchObject({
      outcome: "accepted",
      reason: "Withdrawn: its turn will not run",
      turn: { state: "ended", outcome: { state: "canceled", by: "sender" } },
    });
    expect(getAcpJobByOpId(mine.op_id)?.state).toBe("canceled");
    expect(
      parseTurnOutcome(getAcpJobByOpId(mine.op_id)?.outcome_json),
    ).toMatchObject({ state: "canceled", by: "sender" });
    expect(listDueAgentRpcReports(Date.now() + 3_600_000)).toHaveLength(0);
    // Once is enough.
    expect(await withdraw(attempt)).toMatchObject({
      outcome: "rejected",
      reason: "Its turn has already ended.",
    });
  });

  it("while held until a usage limit resets, keeping the chain's tool use", async () => {
    const attempt = randomUUID();
    const first = job(attempt);
    set(first.op_id, {
      state: "error",
      started_at: first.created_at + 1,
      finished_at: first.created_at + 2,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "limit", scope: "credential" },
        tool_ran: true,
      },
    });
    const held = job(attempt);
    set(held.op_id, {
      created_at: first.created_at + 3,
      recovery_parent_op_id: first.op_id,
      available_at: Date.now() + 3_600_000,
    });
    expect(await withdraw(attempt)).toMatchObject({ outcome: "accepted" });
    expect(getAcpJobByOpId(held.op_id)?.state).toBe("canceled");
    expect(parseTurnOutcome(getAcpJobByOpId(held.op_id)?.outcome_json)).toEqual(
      { version: 1, state: "canceled", by: "sender", tool_ran: true },
    );
  });

  it("not once its turn runs or ended, and never another sender's", async () => {
    const attempt = randomUUID();
    const mine = job(attempt);
    expect(
      await withdraw(attempt, { ...sender, agent_id: randomUUID() }),
    ).toMatchObject({ outcome: "unknown" });
    expect(getAcpJobByOpId(mine.op_id)?.state).toBe("queued");
    set(mine.op_id, { state: "running", started_at: mine.created_at });
    expect(await withdraw(attempt)).toMatchObject({
      outcome: "rejected",
      reason: "Its turn is already running, so it can't be withdrawn.",
      turn: { state: "running" },
    });
    expect(getAcpJobByOpId(mine.op_id)?.state).toBe("running");
  });

  it("while stopped at a limit, before its hold is queued: it never resumes", async () => {
    // Its worker recorded the hold intent, then died before queueing.
    const attempt = randomUUID();
    const mine = job(attempt);
    set(mine.op_id, {
      state: "error",
      started_at: mine.created_at + 1,
      finished_at: mine.created_at + 2,
      recovery_code: "cocalc-hold",
      outcome_json: {
        version: 1,
        state: "failed",
        failure: {
          kind: "limit",
          scope: "credential",
          resets_at: Date.now() + 3_600_000,
        },
        tool_ran: true,
      },
    });
    expect(await withdraw(attempt)).toMatchObject({
      outcome: "accepted",
      reason: "Withdrawn: its turn will not resume",
      turn: {
        state: "ended",
        outcome: { state: "canceled", by: "sender", tool_ran: true },
      },
    });
    expect(getAcpJobByOpId(mine.op_id)?.recovery_code ?? null).toBeNull();
    // The recovery poll has nothing left to hold.
    await acpTestInternals.recoverPendingFailureRecoveryIntents({
      client: { sync: { akv: () => ({}) } } as any,
    });
    expect(
      listAcpJobsByRecoveryParent({ recovery_parent_op_id: mine.op_id }),
    ).toHaveLength(0);
    expect(listDueAgentRpcReports(Date.now() + 3_600_000)).toHaveLength(0);
  });

  it("its chat is updated later if that fails now", async () => {
    const attempt = randomUUID();
    const mine = job(attempt);
    // The chat is unavailable in this test.
    expect(await withdraw(attempt)).toMatchObject({ outcome: "accepted" });
    expect(getAcpJobByOpId(mine.op_id)?.recovery_code).toBe(
      "cocalc-withdrawn-projection",
    );
    const projected: string[] = [];
    // Still failing: kept for the next pass.
    expect(
      await acpTestInternals.retryWithdrawnProjections(10, async () => {
        throw new Error("chat still unavailable");
      }),
    ).toBe(0);
    expect(getAcpJobByOpId(mine.op_id)?.recovery_code).toBe(
      "cocalc-withdrawn-projection",
    );
    expect(
      await acpTestInternals.retryWithdrawnProjections(10, async (row) => {
        projected.push(row.user_message_id);
      }),
    ).toBe(1);
    expect(projected).toEqual([mine.user_message_id]);
    expect(getAcpJobByOpId(mine.op_id)?.recovery_code ?? null).toBeNull();
  });
});
