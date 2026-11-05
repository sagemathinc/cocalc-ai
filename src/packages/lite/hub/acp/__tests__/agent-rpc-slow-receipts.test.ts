import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRpcEnvelope } from "@cocalc/conat/agents/rpc";
import {
  createAgentRpcService,
  type AgentRpcExecutionAdapter,
} from "../agent-rpc-service";
import {
  LAUNCH_SLOW_TEXT,
  LAUNCH_TIMEOUT_TEXT,
  reconcileSlowAgentRpcReceipts,
} from "../agent-rpc-slow-receipts";
import { agentRpcTurnState } from "../agent-rpc-turn";
import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import { enqueueAcpJob, resendCanceledAcpJob } from "../../sqlite/acp-jobs";
import {
  SLOW_RECEIPT_EXPIRY_MS,
  SLOW_RECEIPT_MAX_ROWS,
  claimDueSlowReceipts,
  countSlowReceipts,
  deleteSlowReceipt,
  listSlowReceipts,
  recordSlowReceipt,
  type SlowReceiptBinding,
} from "../../sqlite/agent-rpc-slow-receipts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function fixture() {
  const e: AgentRpcEnvelope = {
    version: 3,
    attempt_id: randomUUID(),
    permit_id: randomUUID(),
    source: { project_id: randomUUID(), agent_id: randomUUID() },
    source_label: "@reviewer",
    target: { project_id: randomUUID(), agent_id: randomUUID() },
    target_label: "@builder",
    run_id: randomUUID(),
    agent_network_id: randomUUID(),
    network_generation: randomUUID(),
    account_generation: 0,
    configured_delivery: "queued",
    guidance: false,
    account_id: randomUUID(),
    path: "/home/user/recv.chat",
    thread_id: randomUUID(),
    deadline: Date.now() + 30_000,
    body: "review request",
  };
  const rows: any[] = [
    {
      event: "chat-thread-config",
      thread_id: e.thread_id,
      agent_kind: "acp",
      agent_model: "gpt-5.4",
    },
  ];
  const sameMessage = (row: any, where: any) =>
    row.event === where.event &&
    row.sender_id === where.sender_id &&
    row.message_id === where.message_id &&
    new Date(row.date).valueOf() === new Date(where.date).valueOf();
  const db = {
    get: () => rows,
    get_one: (where: any) => rows.find((row) => sameMessage(row, where)),
    set: jest.fn((row: any) => {
      const existing = rows.find(
        (value) =>
          value.event === row.event &&
          value.message_id &&
          value.message_id === row.message_id,
      );
      if (existing) Object.assign(existing, row);
      else rows.push({ ...row });
    }),
    commit: jest.fn(),
    save: jest.fn(async () => {}),
    save_to_disk: jest.fn(async () => {}),
  };
  const slowReceipts = {
    record: jest.fn((binding: SlowReceiptBinding) =>
      recordSlowReceipt(binding),
    ),
    delete: jest.fn((binding: SlowReceiptBinding) => {
      deleteSlowReceipt(binding);
    }),
  };
  const deps: AgentRpcExecutionAdapter = {
    authorize: jest.fn(async () => {}),
    ensureRunning: jest.fn(async () => {}),
    withChat: jest.fn(async (_e, fn) => fn(db as any)),
    // As admitPreparedChatSend fails when its acknowledgment window ends.
    admit: jest.fn(async () => {
      throw new Error("timeout waiting for the agent turn to be queued");
    }),
    slowReceipts,
  };
  const message = () => rows.find((row) => row.event === "chat");
  const chats: { project_id: string; path: string }[] = [];
  const reconcile = (
    now: number,
    turnState: typeof agentRpcTurnState = agentRpcTurnState,
  ) =>
    reconcileSlowAgentRpcReceipts({
      withChat: async (project_id, path, fn) => {
        chats.push({ project_id, path });
        return await fn(db as any);
      },
      turnState,
      now: () => now,
    });
  // The turn admission queued (late), for this attempt.
  const queueTurn = (
    overrides: {
      account_id?: string;
      agent_network_id?: string;
      source?: AgentRpcEnvelope["source"];
    } = {},
  ) =>
    enqueueAcpJob({
      project_id: e.target.project_id,
      account_id: overrides.account_id ?? e.account_id,
      session_id: randomUUID(),
      prompt: "hi",
      config: { workingDirectory: "/tmp" },
      chat: {
        project_id: e.target.project_id,
        path: e.path,
        thread_id: e.thread_id,
        parent_message_id: randomUUID(),
        message_id: message()?.message_id ?? randomUUID(),
        message_date: new Date().toISOString(),
        sender_id: "openai-codex-agent",
        agent_rpc_execution: {
          version: 3,
          source: overrides.source ?? e.source,
          target: e.target,
          target_path: e.path,
          target_thread_id: e.thread_id,
          agent_network_id: overrides.agent_network_id ?? e.agent_network_id,
          network_generation: e.network_generation,
          account_generation: 0,
          configured_delivery: "queued",
          principal_account_id: overrides.account_id ?? e.account_id,
          guidance: false,
          attempt_id: e.attempt_id,
        },
      },
    } as any);
  return {
    e,
    rows,
    db,
    deps,
    slowReceipts,
    message,
    chats,
    reconcile,
    queueTurn,
    service: createAgentRpcService(deps),
  };
}

function bindingOf(f: ReturnType<typeof fixture>): SlowReceiptBinding {
  const m = f.message();
  return {
    attempt_id: f.e.attempt_id,
    agent_network_id: f.e.agent_network_id,
    source: f.e.source,
    target: f.e.target,
    account_id: f.e.account_id,
    project_id: f.e.target.project_id,
    path: f.e.path,
    message_date: new Date(m.date).toISOString(),
    sender_id: m.sender_id,
    message_id: m.message_id,
  };
}

const createdAt = () => listSlowReceipts()[0]?.created_at ?? 0;

// The job store sets up its tables once per process: one database for all
// tests here (but the restart test, last), emptied before each.
beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
});
beforeEach(() => {
  countSlowReceipts();
  getAcpDatabase().exec("DELETE FROM acp_agent_rpc_slow_receipts");
  try {
    getAcpDatabase().exec("DELETE FROM acp_jobs");
  } catch {
    // Not created yet.
  }
});
afterAll(() => closeAcpDatabase());

test("a timed-out acknowledgment is recorded first, then the receipt says slow", async () => {
  const f = fixture();
  const order: string[] = [];
  f.slowReceipts.record.mockImplementation((binding) => {
    order.push(`row:${f.message().agent_rpc_launch.state}`);
    return recordSlowReceipt(binding);
  });
  const outcome = await f.service.submit(f.e);
  expect(outcome).toMatchObject({ outcome: "unknown", chat_effect: "saved" });
  // The receipt was still pending when the row went in.
  expect(order).toEqual(["row:pending"]);
  expect(f.message().agent_rpc_launch).toMatchObject({
    state: "unknown",
    slow: true,
    error: LAUNCH_SLOW_TEXT,
  });
  const [row] = listSlowReceipts();
  expect(row).toMatchObject({
    ...bindingOf(f),
    checks: 0,
  });
  // Identity and chat locator only: nothing from the message's content.
  expect(JSON.stringify(row)).not.toContain(f.e.body);
});

test("other launch failures are unchanged: no row, no slow receipt", async () => {
  const f = fixture();
  (f.deps.admit as jest.Mock).mockRejectedValue(new Error("ack lost"));
  await f.service.submit(f.e);
  expect(f.message().agent_rpc_launch.state).toBe("unknown");
  expect(f.message().agent_rpc_launch.slow).toBeUndefined();
  expect(countSlowReceipts()).toBe(0);
});

test("late acceptance: the turn appears and the receipt becomes accepted", async () => {
  const f = fixture();
  await f.service.submit(f.e);
  const t0 = createdAt();
  // Not due yet; then due, but no turn: it waits.
  expect((await f.reconcile(t0 + 1 * SECOND)).claimed).toBe(0);
  expect(await f.reconcile(t0 + 6 * SECOND)).toMatchObject({
    claimed: 1,
    waiting: 1,
  });
  expect(f.message().agent_rpc_launch.slow).toBe(true);
  f.queueTurn();
  expect(await f.reconcile(t0 + 2 * MINUTE)).toMatchObject({ accepted: 1 });
  expect(f.message().agent_rpc_launch).toEqual({
    state: "accepted",
    confirmed_late: true,
    updated_at: t0 + 2 * MINUTE,
  });
  expect(countSlowReceipts()).toBe(0);
  expect(f.chats).toEqual([
    { project_id: f.e.target.project_id, path: f.e.path },
  ]);
});

test.each([
  ["another account", { account_id: randomUUID() }],
  ["another network", { agent_network_id: randomUUID() }],
  [
    "another source",
    { source: { project_id: randomUUID(), agent_id: randomUUID() } },
  ],
])(
  "binding: a job for the same attempt id but %s is not this turn",
  async (_label, overrides) => {
    const f = fixture();
    await f.service.submit(f.e);
    f.queueTurn(overrides);
    expect(await f.reconcile(createdAt() + 6 * SECOND)).toMatchObject({
      waiting: 1,
    });
    expect(f.message().agent_rpc_launch.slow).toBe(true);
    expect(countSlowReceipts()).toBe(1);
  },
);

test("the lookup uses the row's authorized account, never the message's content", async () => {
  const f = fixture();
  await f.service.submit(f.e);
  // Whatever the message says about accounts plays no part.
  const m = f.message();
  m.sender_id = randomUUID();
  m.history = [{ author_id: randomUUID(), content: `account ${randomUUID()}` }];
  const lookups: any[] = [];
  await f.reconcile(createdAt() + 6 * SECOND, (source, attempt, accountId) => {
    lookups.push({ source, attempt, accountId });
    return undefined;
  });
  expect(lookups).toEqual([
    {
      source: f.e.source,
      attempt: {
        version: 3,
        attempt_id: f.e.attempt_id,
        agent_network_id: f.e.agent_network_id,
        target: f.e.target,
      },
      accountId: f.e.account_id,
    },
  ]);
});

test("the lookup's account is the row's principal, even where the message's sender differs", async () => {
  const b = { ...bindingOfFake(), message_date: new Date(0).toISOString() };
  expect(recordSlowReceipt(b, 0)).toBe("recorded");
  const accounts: string[] = [];
  await reconcileSlowAgentRpcReceipts({
    withChat: async (_project_id, _path, fn) =>
      await fn({ get_one: () => undefined } as any),
    turnState: (_source, _attempt, accountId) => {
      accounts.push(accountId);
      return undefined;
    },
    now: () => 10 * SECOND,
  });
  expect(b.sender_id).not.toBe(b.account_id);
  expect(accounts).toEqual([b.account_id]);
});

describe("the receipt compare-and-set", () => {
  test.each([
    ["accepted", { state: "accepted", updated_at: 1 }],
    ["rejected", { state: "rejected", updated_at: 1 }],
    ["plain unknown", { state: "unknown", error: "x", updated_at: 1 }],
  ])("a receipt already %s is never overwritten", async (_label, launch) => {
    const f = fixture();
    await f.service.submit(f.e);
    f.queueTurn();
    f.message().agent_rpc_launch = launch;
    f.db.set.mockClear();
    expect(await f.reconcile(createdAt() + 6 * SECOND)).toMatchObject({
      settled: 1,
    });
    expect(f.message().agent_rpc_launch).toEqual(launch);
    expect(f.db.set).not.toHaveBeenCalled();
    expect(countSlowReceipts()).toBe(0);
  });

  test("a message now carrying another attempt is never overwritten", async () => {
    const f = fixture();
    await f.service.submit(f.e);
    f.queueTurn();
    f.message().agent_rpc = {
      ...f.message().agent_rpc,
      attempt_id: randomUUID(),
    };
    f.db.set.mockClear();
    expect(await f.reconcile(createdAt() + 6 * SECOND)).toMatchObject({
      settled: 1,
    });
    expect(f.message().agent_rpc_launch.slow).toBe(true);
    expect(f.db.set).not.toHaveBeenCalled();
    expect(countSlowReceipts()).toBe(0);
  });

  test("withdrawn first (the turn canceled), then the reconciler: the receipt records the admission", async () => {
    const f = fixture();
    await f.service.submit(f.e);
    const job = f.queueTurn();
    getAcpDatabase()
      .prepare(
        `UPDATE acp_jobs SET state = 'canceled', finished_at = ? WHERE op_id = ?`,
      )
      .run(Date.now(), job.op_id);
    await f.reconcile(createdAt() + 6 * SECOND);
    // It was admitted; the chat's own turn state says it was withdrawn.
    expect(f.message().agent_rpc_launch).toMatchObject({
      state: "accepted",
      confirmed_late: true,
    });
    expect(countSlowReceipts()).toBe(0);
  });
});

describe("crash between the row and the receipt", () => {
  async function rowWithPendingReceipt() {
    const f = fixture();
    // The message saved, the row recorded, and then the process died.
    f.deps.withChat = jest
      .fn()
      .mockImplementationOnce(async (_e, fn) => fn(f.db as any))
      .mockImplementation(async () => {
        throw new Error("process exited");
      });
    await f.service.submit(f.e);
    expect(f.message().agent_rpc_launch.state).toBe("pending");
    expect(countSlowReceipts()).toBe(1);
    return f;
  }

  test("with a turn: accepted", async () => {
    const f = await rowWithPendingReceipt();
    f.queueTurn();
    await f.reconcile(createdAt() + 6 * SECOND);
    expect(f.message().agent_rpc_launch).toMatchObject({ state: "accepted" });
    expect(countSlowReceipts()).toBe(0);
  });

  test("without a turn: pending until the expiry, then plain unknown", async () => {
    const f = await rowWithPendingReceipt();
    const t0 = createdAt();
    await f.reconcile(t0 + 6 * SECOND);
    expect(f.message().agent_rpc_launch.state).toBe("pending");
    expect(countSlowReceipts()).toBe(1);
    await f.reconcile(t0 + SLOW_RECEIPT_EXPIRY_MS);
    expect(f.message().agent_rpc_launch).toEqual({
      state: "unknown",
      error: LAUNCH_TIMEOUT_TEXT,
      updated_at: t0 + SLOW_RECEIPT_EXPIRY_MS,
    });
    expect(countSlowReceipts()).toBe(0);
  });

  test("a pending receipt of another attempt is never written", async () => {
    const f = await rowWithPendingReceipt();
    f.message().agent_rpc = {
      ...f.message().agent_rpc,
      attempt_id: randomUUID(),
    };
    f.queueTurn();
    f.db.set.mockClear();
    await f.reconcile(createdAt() + 6 * SECOND);
    expect(f.message().agent_rpc_launch.state).toBe("pending");
    expect(f.db.set).not.toHaveBeenCalled();
    expect(countSlowReceipts()).toBe(0);
  });
});

test("crash between a receipt write and the row's removal: the next pass only removes the row", async () => {
  const f = fixture();
  await f.service.submit(f.e);
  f.queueTurn();
  f.db.save_to_disk.mockRejectedValueOnce(new Error("disk full"));
  const t0 = createdAt();
  expect(await f.reconcile(t0 + 6 * SECOND)).toMatchObject({ failed: 1 });
  // Committed in the document, not yet saved: the row stays.
  expect(f.message().agent_rpc_launch.state).toBe("accepted");
  expect(countSlowReceipts()).toBe(1);
  f.db.set.mockClear();
  f.db.save_to_disk.mockClear();
  expect(await f.reconcile(t0 + 2 * MINUTE)).toMatchObject({ settled: 1 });
  expect(f.db.set).not.toHaveBeenCalled();
  // Saved this time, before the row went.
  expect(f.db.save_to_disk).toHaveBeenCalledTimes(1);
  expect(countSlowReceipts()).toBe(0);
});

describe("no usable row: the receipt is plain unknown, as before", () => {
  test("the row could not be recorded", async () => {
    const f = fixture();
    f.slowReceipts.record.mockImplementation(() => {
      throw new Error("database is locked");
    });
    await f.service.submit(f.e);
    expect(f.message().agent_rpc_launch).toMatchObject({
      state: "unknown",
      error: LAUNCH_TIMEOUT_TEXT,
    });
    expect(f.message().agent_rpc_launch.slow).toBeUndefined();
    expect(countSlowReceipts()).toBe(0);
  });

  test("the table is full: no row is evicted for it", async () => {
    const other = fixture();
    const base = { ...bindingOfFake() };
    for (let i = 0; i < SLOW_RECEIPT_MAX_ROWS; i++)
      expect(recordSlowReceipt({ ...base, attempt_id: `a${i}` })).toBe(
        "recorded",
      );
    await other.service.submit(other.e);
    expect(other.message().agent_rpc_launch.slow).toBeUndefined();
    expect(other.message().agent_rpc_launch.state).toBe("unknown");
    expect(countSlowReceipts()).toBe(SLOW_RECEIPT_MAX_ROWS);
    expect(listSlowReceipts()[0].attempt_id).toBe("a0");
  });

  test("an attempt id with a row about another message: that row is left alone", async () => {
    const f = fixture();
    const foreign = { ...bindingOfFake(), attempt_id: f.e.attempt_id };
    expect(recordSlowReceipt(foreign)).toBe("recorded");
    await f.service.submit(f.e);
    expect(f.message().agent_rpc_launch.slow).toBeUndefined();
    expect(f.message().agent_rpc_launch.state).toBe("unknown");
    expect(listSlowReceipts()).toMatchObject([foreign]);
  });
});

function bindingOfFake(): SlowReceiptBinding {
  return {
    attempt_id: randomUUID(),
    agent_network_id: randomUUID(),
    source: { project_id: randomUUID(), agent_id: randomUUID() },
    target: { project_id: randomUUID(), agent_id: randomUUID() },
    account_id: randomUUID(),
    project_id: randomUUID(),
    path: "/home/user/other.chat",
    message_date: new Date(0).toISOString(),
    sender_id: randomUUID(),
    message_id: randomUUID(),
  };
}

test("recording the same binding again is the same row", () => {
  const b = bindingOfFake();
  expect(recordSlowReceipt(b)).toBe("recorded");
  // Equal, built with its keys in another order.
  const reordered = {
    ...b,
    source: {
      agent_id: b.source.agent_id,
      project_id: (b.source as any).project_id,
    },
  };
  expect(recordSlowReceipt(reordered as any, Date.now() + HOUR)).toBe(
    "recorded",
  );
  expect(countSlowReceipts()).toBe(1);
  expect(recordSlowReceipt({ ...b, message_id: randomUUID() })).toBe(
    "conflict",
  );
  expect(recordSlowReceipt({ ...b, account_id: randomUUID() })).toBe(
    "conflict",
  );
  expect(countSlowReceipts()).toBe(1);
});

describe("races before the first slow receipt write", () => {
  test.each([
    [
      "a late accept",
      (m: any) => (m.agent_rpc_launch = { state: "accepted", updated_at: 2 }),
    ],
    [
      "a rejection",
      (m: any) => (m.agent_rpc_launch = { state: "rejected", updated_at: 2 }),
    ],
    [
      "a newer attempt",
      (m: any) => (m.agent_rpc = { ...m.agent_rpc, attempt_id: randomUUID() }),
    ],
  ])("%s wins: nothing written, the row removed", async (_label, change) => {
    const f = fixture();
    f.slowReceipts.record.mockImplementation((binding) => {
      const result = recordSlowReceipt(binding);
      change(f.message());
      f.db.set.mockClear();
      return result;
    });
    await f.service.submit(f.e);
    // The newer state stands: no write after it.
    expect(f.db.set).not.toHaveBeenCalled();
    expect(f.message().agent_rpc_launch.slow).toBeUndefined();
    expect(f.message().agent_rpc_launch.state).not.toBe("unknown");
    expect(f.slowReceipts.delete).toHaveBeenCalledTimes(1);
    expect(countSlowReceipts()).toBe(0);
  });

  test("the first chat write fails: the row stays, and the reconciler settles it", async () => {
    const f = fixture();
    let calls = 0;
    f.deps.withChat = jest.fn(async (_e, fn) => {
      if (++calls === 2) throw new Error("chat unavailable");
      return fn(f.db as any);
    });
    await f.service.submit(f.e);
    expect(f.message().agent_rpc_launch.state).toBe("pending");
    expect(countSlowReceipts()).toBe(1);
    f.queueTurn();
    await f.reconcile(createdAt() + 6 * SECOND);
    expect(f.message().agent_rpc_launch.state).toBe("accepted");
    expect(countSlowReceipts()).toBe(0);
  });

  test("the plain-unknown fallback loses to a late accept: nothing written", async () => {
    const f = fixture();
    f.slowReceipts.record.mockImplementation(() => {
      f.message().agent_rpc_launch = { state: "accepted", updated_at: 2 };
      return "full";
    });
    await f.service.submit(f.e);
    expect(f.message().agent_rpc_launch).toEqual({
      state: "accepted",
      updated_at: 2,
    });
  });

  test("the plain-unknown fallback's write fails: pending, as before, and no row", async () => {
    const f = fixture();
    f.slowReceipts.record.mockReturnValue("full");
    let calls = 0;
    f.deps.withChat = jest.fn(async (_e, fn) => {
      if (++calls === 2) throw new Error("chat unavailable");
      return fn(f.db as any);
    });
    await f.service.submit(f.e);
    expect(f.message().agent_rpc_launch.state).toBe("pending");
    expect(countSlowReceipts()).toBe(0);
  });
});

test("two passes at once: each row is claimed once", () => {
  for (let i = 0; i < 3; i++) recordSlowReceipt(bindingOfFake(), 1_000);
  const first = claimDueSlowReceipts(10_000);
  const second = claimDueSlowReceipts(10_000);
  expect(first).toHaveLength(3);
  expect(second).toHaveLength(0);
});

test("the claim backs off, and never past the expiry", () => {
  recordSlowReceipt(bindingOfFake(), 0);
  const checks: number[] = [];
  let now = 0;
  for (let i = 0; i < 12; i++) {
    const [row] = claimDueSlowReceipts(now);
    if (row) checks.push(row.next_check_at - now);
    now = listSlowReceipts()[0].next_check_at;
  }
  expect(checks.slice(0, 4)).toEqual([
    30 * SECOND,
    2 * MINUTE,
    5 * MINUTE,
    5 * MINUTE,
  ]);
  // Due exactly at the expiry, once.
  expect(listSlowReceipts()[0].next_check_at >= SLOW_RECEIPT_EXPIRY_MS).toBe(
    true,
  );
  expect(checks.every((delay) => delay > 0)).toBe(true);
});

describe("expiry and the 24 hour path", () => {
  test("no turn after 30 minutes: plain unknown, today's warning", async () => {
    const f = fixture();
    await f.service.submit(f.e);
    const t0 = createdAt();
    await f.reconcile(t0 + SLOW_RECEIPT_EXPIRY_MS - 1);
    expect(f.message().agent_rpc_launch.slow).toBe(true);
    await f.reconcile(t0 + SLOW_RECEIPT_EXPIRY_MS);
    expect(f.message().agent_rpc_launch).toMatchObject({
      state: "unknown",
      error: LAUNCH_TIMEOUT_TEXT,
    });
    expect(f.message().agent_rpc_launch.slow).toBeUndefined();
    expect(countSlowReceipts()).toBe(0);
  });

  test("a row whose chat writes failed for a day is made final before it goes, or kept", async () => {
    const f = fixture();
    await f.service.submit(f.e);
    const t0 = createdAt();
    const failing = (now: number) =>
      reconcileSlowAgentRpcReceipts({
        withChat: async () => {
          throw new Error("chat unavailable");
        },
        turnState: agentRpcTurnState,
        now: () => now,
      });
    for (const at of [t0 + SLOW_RECEIPT_EXPIRY_MS, t0 + 25 * HOUR])
      expect(await failing(at)).toMatchObject({ failed: 1 });
    expect(countSlowReceipts()).toBe(1);
    expect(f.message().agent_rpc_launch.slow).toBe(true);
    await f.reconcile(t0 + 26 * HOUR);
    expect(f.message().agent_rpc_launch).toMatchObject({
      state: "unknown",
      error: LAUNCH_TIMEOUT_TEXT,
    });
    expect(countSlowReceipts()).toBe(0);
  });

  test("the message is gone: the row is removed, nothing written", async () => {
    const f = fixture();
    await f.service.submit(f.e);
    const index = f.rows.findIndex((row) => row.event === "chat");
    f.rows.splice(index, 1);
    f.db.set.mockClear();
    await f.reconcile(createdAt() + SLOW_RECEIPT_EXPIRY_MS);
    expect(f.db.set).not.toHaveBeenCalled();
    expect(countSlowReceipts()).toBe(0);
  });
});

test("no duplicate turn: resending a queued, running or completed turn re-queues nothing", () => {
  const f = fixture();
  const job = f.queueTurn();
  const key = {
    project_id: job.project_id,
    path: job.path,
    user_message_id: job.user_message_id,
    account_id: job.account_id!,
    thread_id: job.thread_id,
  };
  const count = () =>
    (
      getAcpDatabase().prepare(`SELECT COUNT(*) AS n FROM acp_jobs`).get() as {
        n: number;
      }
    ).n;
  const row = () =>
    getAcpDatabase()
      .prepare(`SELECT * FROM acp_jobs WHERE op_id = ?`)
      .get(job.op_id);
  for (const state of ["queued", "running", "completed"]) {
    getAcpDatabase()
      .prepare(`UPDATE acp_jobs SET state = ?, updated_at = 1 WHERE op_id = ?`)
      .run(state, job.op_id);
    const before = row();
    // It answers with the existing job, unchanged: nothing re-queued, no
    // second job (the caller reports anything but queued as not resent).
    expect(resendCanceledAcpJob(key)).toMatchObject({
      op_id: job.op_id,
      state,
    });
    expect(row()).toEqual(before);
    expect(count()).toBe(1);
  }
});

test("restart: rows survive closing the database, and the next pass settles them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slow-receipts-"));
  try {
    closeAcpDatabase();
    initAcpDatabase({ filename: join(dir, "acp.sqlite") });
    const f = fixture();
    await f.service.submit(f.e);
    closeAcpDatabase();
    initAcpDatabase({ filename: join(dir, "acp.sqlite") });
    expect(countSlowReceipts()).toBe(1);
    // (The job store's tables are not in this file: its turn, as found.)
    await f.reconcile(
      createdAt() + 6 * SECOND,
      () =>
        ({
          state: "queued",
          queued_at: 1,
        }) as any,
    );
    expect(f.message().agent_rpc_launch.state).toBe("accepted");
    expect(countSlowReceipts()).toBe(0);
  } finally {
    closeAcpDatabase();
    rmSync(dir, { recursive: true, force: true });
  }
});
