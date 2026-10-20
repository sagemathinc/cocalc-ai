import { randomUUID } from "node:crypto";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  ACP_FENCE_INTENT_RESUME_PENDING,
  enqueueAcpJob,
  listQueuedAcpJobs,
} from "../../sqlite/acp-jobs";
import { agentRpcTurnSummary } from "@cocalc/conat/agents/rpc-turn";
import { agentRpcTurnState } from "../agent-rpc-turn";

const NETWORK = "88888888-8888-4888-8888-888888888888";
const ACCOUNT = "00000000-1000-4000-8000-000000000001";
const PROJECT = "00000000-1000-4000-8000-000000000000";
const sender = {
  project_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "22222222-2222-4222-8222-222222222222",
};
const target = {
  project_id: PROJECT,
  agent_id: "44444444-4444-4444-8444-444444444444",
};

function job({
  attempt_id,
  source = sender,
  account_id = ACCOUNT,
  agent_network_id = NETWORK,
}: {
  attempt_id?: string;
  source?: typeof sender;
  account_id?: string;
  agent_network_id?: string;
}) {
  const message = randomUUID();
  return enqueueAcpJob({
    project_id: PROJECT,
    account_id,
    session_id: randomUUID(),
    prompt: "hi",
    config: { workingDirectory: "/tmp" },
    chat: {
      project_id: PROJECT,
      path: "/tmp/agent-rpc-turn.chat",
      thread_id: "thread-1",
      parent_message_id: randomUUID(),
      message_id: message,
      message_date: new Date().toISOString(),
      sender_id: "openai-codex-agent",
      ...(attempt_id
        ? {
            agent_rpc_execution: {
              version: 3,
              source,
              target,
              target_path: "/tmp/agent-rpc-turn.chat",
              target_thread_id: "thread-1",
              agent_network_id,
              network_generation: "99999999-9999-4999-8999-999999999999",
              account_generation: 1,
              configured_delivery: "queued",
              principal_account_id: account_id,
              guidance: false,
              attempt_id,
            },
          }
        : {}),
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

const inspect = (
  attempt_id: string,
  source = sender,
  account = ACCOUNT,
  agent_network_id = NETWORK,
) =>
  agentRpcTurnState(
    source,
    {
      version: 3,
      attempt_id,
      agent_network_id,
      target,
    } as any,
    account,
  );

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
  listQueuedAcpJobs();
});
beforeEach(() => {
  getAcpDatabase().prepare("DELETE FROM acp_jobs").run();
});
afterAll(() => closeAcpDatabase());

describe("what became of the turn an agent message started", () => {
  it("queued behind other turns, then running, then how it ended", () => {
    job({});
    job({});
    const attempt = randomUUID();
    const mine = job({ attempt_id: attempt });
    expect(inspect(attempt)).toEqual({
      state: "queued",
      queued_at: mine.created_at,
      ahead_in_queue: 2,
      tool_ran: false,
    });
    set(mine.op_id, { state: "running", started_at: mine.created_at + 5 });
    expect(inspect(attempt)).toEqual({
      state: "running",
      queued_at: mine.created_at,
      started_at: mine.created_at + 5,
    });
    const outcome = {
      version: 1,
      state: "failed",
      failure: { kind: "limit", scope: "credential", resets_at: 123 },
      tool_ran: false,
    };
    set(mine.op_id, {
      state: "error",
      finished_at: mine.created_at + 9,
      outcome_json: outcome,
    });
    expect(inspect(attempt)).toEqual({
      state: "ended",
      queued_at: mine.created_at,
      started_at: mine.created_at + 5,
      ended_at: mine.created_at + 9,
      outcome,
      tool_ran: false,
    });
  });

  it.each(["canceled", "error", "interrupted"])(
    "held while a restart waits for the project to run again (fenced %s)",
    (state) => {
      // Queued when the project stopped: canceled; running: error (ACP) or
      // interrupted. Either way it resumes.
      const attempt = randomUUID();
      const mine = job({ attempt_id: attempt });
      set(mine.op_id, {
        state,
        ...(state === "canceled" ? {} : { started_at: mine.created_at + 1 }),
        recovery_code: ACP_FENCE_INTENT_RESUME_PENDING,
      });
      expect(inspect(attempt)).toMatchObject({ state: "queued", held: true });
    },
  );

  it("follows a cut-off turn to its continuation, with the chain's tool use", () => {
    const attempt = randomUUID();
    const first = job({ attempt_id: attempt });
    set(first.op_id, {
      state: "error",
      started_at: first.created_at + 1,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "host-lost" },
        tool_ran: true,
      },
    });
    const next = job({ attempt_id: attempt });
    set(next.op_id, {
      state: "error",
      created_at: first.created_at + 2,
      started_at: first.created_at + 3,
      finished_at: first.created_at + 4,
      recovery_parent_op_id: first.op_id,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "error" },
        tool_ran: false,
      },
    });
    expect(inspect(attempt)).toEqual({
      state: "ended",
      queued_at: first.created_at,
      started_at: first.created_at + 1,
      ended_at: first.created_at + 4,
      outcome: {
        version: 1,
        state: "failed",
        failure: { kind: "error" },
        tool_ran: true,
      },
      tool_ran: true,
    });
  });

  it("an earlier attempt's tools count when the last never started", () => {
    const attempt = randomUUID();
    const first = job({ attempt_id: attempt });
    set(first.op_id, {
      state: "error",
      started_at: first.created_at + 1,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "host-lost" },
        tool_ran: true,
      },
    });
    const next = job({ attempt_id: attempt });
    set(next.op_id, {
      state: "canceled",
      created_at: first.created_at + 2,
      recovery_parent_op_id: first.op_id,
      outcome_json: { version: 1, state: "never-started", reason: "canceled" },
    });
    const turn = inspect(attempt)!;
    expect(turn).toMatchObject({ state: "ended", tool_ran: true });
    expect(agentRpcTurnSummary(turn)).toMatch(/It had run tools/);
  });

  it("a continuation waiting to resume is not an untouched turn", () => {
    const attempt = randomUUID();
    const first = job({ attempt_id: attempt });
    set(first.op_id, {
      state: "error",
      started_at: first.created_at + 1,
      outcome_json: {
        version: 1,
        state: "failed",
        failure: { kind: "host-lost" },
        tool_ran: true,
      },
    });
    const next = job({ attempt_id: attempt });
    set(next.op_id, {
      created_at: first.created_at + 2,
      recovery_parent_op_id: first.op_id,
    });
    const turn = inspect(attempt)!;
    expect(turn).toMatchObject({
      state: "queued",
      started_at: first.created_at + 1,
      tool_ran: true,
    });
    expect(agentRpcTurnSummary(turn)).toMatch(
      /^Started .*; interrupted and waiting to resume\. It had run tools/,
    );
  });

  it("counts the turns ahead in the order the scheduler takes them", () => {
    const attempt = randomUUID();
    const older = job({});
    const mine = job({ attempt_id: attempt });
    const later = job({});
    const notDue = job({});
    // Older normal job, my turn sent immediately: mine goes first.
    set(older.op_id, { created_at: 1000 });
    set(mine.op_id, { created_at: 2000, priority: 1, updated_at: 2000 });
    set(later.op_id, { created_at: 3000, priority: 1, updated_at: 3000 });
    // Would go first, but is not due yet.
    set(notDue.op_id, {
      created_at: 500,
      priority: 1,
      updated_at: 9000,
      available_at: Date.now() + 3_600_000,
    });
    // The later immediate job was sent after mine, so it runs first.
    expect(inspect(attempt)).toMatchObject({ ahead_in_queue: 1 });
    set(later.op_id, { priority: 0 });
    expect(inspect(attempt)).toMatchObject({ ahead_in_queue: 0 });
  });

  it("only for the agent that sent it, in its account", () => {
    const attempt = randomUUID();
    job({ attempt_id: attempt });
    expect(inspect(attempt)).toBeDefined();
    expect(
      inspect(attempt, { ...sender, agent_id: randomUUID() }),
    ).toBeUndefined();
    expect(inspect(attempt, sender, randomUUID())).toBeUndefined();
    expect(inspect(randomUUID())).toBeUndefined();
  });

  it("only the turn sent in that Agent Network", () => {
    const attempt = randomUUID();
    const other = "77777777-7777-4777-8777-777777777777";
    const mine = job({ attempt_id: attempt });
    const theirs = job({ attempt_id: attempt, agent_network_id: other });
    set(theirs.op_id, { state: "running", started_at: theirs.created_at });
    expect(inspect(attempt)).toMatchObject({ state: "queued" });
    expect(inspect(attempt, sender, ACCOUNT, other)).toMatchObject({
      state: "running",
      queued_at: theirs.created_at,
    });
    expect(mine.op_id).not.toBe(theirs.op_id);
  });
});
