import { randomUUID } from "node:crypto";
import { encodeRuntimeSponsorDenial } from "@cocalc/util/runtime-sponsor-denial";
import {
  createAgentRpcService,
  type AgentRpcExecutionAdapter,
} from "../agent-rpc-service";
import type { AgentRpcEnvelope } from "@cocalc/conat/agents/rpc";
import { rpcOutcome } from "@cocalc/conat/agents/rpc";
import { AgentRpcAttempts } from "@cocalc/conat/agents/rpc-attempts";
import { AgentRpcCapacity } from "@cocalc/conat/agents/rpc-capacity";

function fixture() {
  const e: AgentRpcEnvelope = {
    version: 2,
    attempt_id: randomUUID(),
    permit_id: randomUUID(),
    source: { project_id: randomUUID(), agent_id: randomUUID() },
    target: { project_id: randomUUID(), agent_id: randomUUID() },
    run_id: randomUUID(),
    link_id: randomUUID(),
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
  const db = {
    get: () => rows,
    set: jest.fn((row) => rows.push(row)),
    commit: jest.fn(),
    save: jest.fn(async () => {}),
    save_to_disk: jest.fn(async () => {}),
  };
  const deps: AgentRpcExecutionAdapter = {
    authorize: jest.fn(async () => {}),
    ensureRunning: jest.fn(async () => {}),
    withChat: async (_e, fn) => fn(db as any),
    admit: jest.fn(async () => {}),
  };
  return { e, db, deps, service: createAgentRpcService(deps) };
}

test("idle wake and busy queue use one existing admission call with target identity", async () => {
  const { e, deps, service, db } = fixture();
  expect((await service.submit(e)).outcome).toBe("accepted");
  expect(deps.admit).toHaveBeenCalledTimes(1);
  expect(deps.ensureRunning).toHaveBeenCalledWith(e);
  const prepared = (deps.admit as jest.Mock).mock.calls[0][0];
  expect(prepared.request.account_id).toBe(e.account_id);
  expect(prepared.request.project_id).toBe(e.target.project_id);
  expect(prepared.request.chat.agent_delivery_id).toBeUndefined();
  expect(db.set).toHaveBeenCalledTimes(1);
  expect(db.set.mock.calls[0][0].agent_rpc).toEqual({
    version: 2,
    source: e.source,
    target: e.target,
    source_run_id: e.run_id,
    link_id: e.link_id,
    attempt_id: e.attempt_id,
  });
  expect(service.inspect(e.source, e, e.account_id).outcome).toBe("accepted");
  await service.submit(e);
  expect(deps.admit).toHaveBeenCalledTimes(1);
});

test("unavailable chat rejects before admission", async () => {
  const { e, deps, service } = fixture();
  deps.withChat = async () => {
    throw new Error("offline");
  };
  expect(await service.submit(e)).toMatchObject({
    outcome: "rejected",
    chat_effect: "none",
  });
  expect(deps.admit).not.toHaveBeenCalled();
});

test("revocation after chat save rejects and preserves saved chat", async () => {
  const { e, deps, db, service } = fixture();
  db.save_to_disk.mockImplementation(async () => {
    deps.authorize = async () => {
      throw new Error("revoked");
    };
  });
  expect(await service.submit(e)).toMatchObject({
    outcome: "rejected",
    chat_effect: "saved",
  });
  expect(deps.admit).not.toHaveBeenCalled();
  expect(db.set).toHaveBeenCalledTimes(1);
});

test("lost execution ack is unknown and cannot cause a recovery admission", async () => {
  const { e, deps, service } = fixture();
  deps.admit = jest.fn(async () => {
    throw new Error("ack lost after queue admission");
  });
  expect((await service.submit(e)).outcome).toBe("unknown");
  expect(service.inspect(e.source, e, e.account_id).outcome).toBe("unknown");
  await service.submit(e);
  expect(deps.admit).toHaveBeenCalledTimes(1);
  await service.submit({ ...e, attempt_id: randomUUID() });
  expect(deps.admit).toHaveBeenCalledTimes(2);
});

test("expired deadline cannot start work even after delayed preparation", async () => {
  const { e, deps, service } = fixture();
  e.deadline = Date.now() - 1;
  expect((await service.submit(e)).outcome).toBe("rejected");
  expect(deps.admit).not.toHaveBeenCalled();
  expect(deps.ensureRunning).not.toHaveBeenCalled();
});

test.each([
  [
    "Automatic starts are disabled for this project",
    "automatic starts disabled",
  ],
  [
    encodeRuntimeSponsorDenial({
      code: "runtime_sponsor_slots_exhausted",
      sponsor_account_id: randomUUID(),
      limit: 1,
      current: 1,
      active_projects: [],
    }),
    "no available running-project slots",
  ],
  ["project move is in progress", "could not start under its runtime policy"],
])(
  "start refusal %s does not save or submit a message",
  async (error, reason) => {
    const { e, deps, service, db } = fixture();
    deps.ensureRunning = jest.fn(async () => {
      throw new Error(error);
    });
    expect(await service.submit(e)).toMatchObject({
      outcome: "rejected",
      chat_effect: "none",
      reason: expect.stringContaining(reason),
    });
    expect(db.set).not.toHaveBeenCalled();
    expect(deps.admit).not.toHaveBeenCalled();
  },
);

test("revocation during startup prevents save and execution", async () => {
  const { e, deps, service, db } = fixture();
  deps.ensureRunning = async () => {
    deps.authorize = async () => {
      throw new Error("link revoked");
    };
  };
  expect((await service.submit(e)).outcome).toBe("rejected");
  expect(db.set).not.toHaveBeenCalled();
  expect(deps.admit).not.toHaveBeenCalled();
});

test("startup timeout is unknown and late completion cannot deliver", async () => {
  jest.useFakeTimers();
  try {
    const { e, deps, service, db } = fixture();
    let finish!: () => void;
    deps.ensureRunning = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    e.deadline = Date.now() + 30;
    const submission = service.submit(e);
    await jest.advanceTimersByTimeAsync(31);
    const result = await submission;
    expect(result).toMatchObject({
      outcome: "unknown",
      chat_effect: "none",
      reason: expect.stringContaining("startup was not confirmed"),
    });
    finish();
    await jest.advanceTimersByTimeAsync(1);
    expect(db.set).not.toHaveBeenCalled();
    expect(deps.admit).not.toHaveBeenCalled();
    expect(service.inspect(e.source, e, e.account_id).outcome).toBe("unknown");
    expect(deps.ensureRunning).toHaveBeenCalledTimes(1);
    await service.submit(e);
    expect(deps.ensureRunning).toHaveBeenCalledTimes(1);
    deps.ensureRunning = jest.fn(async () => {});
    const retry = {
      ...e,
      attempt_id: randomUUID(),
      deadline: Date.now() + 1000,
    };
    expect((await service.submit(retry)).outcome).toBe("accepted");
    expect(deps.admit).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test("archived thread and inspection never wake the project", async () => {
  const { e, deps, service, db } = fixture();
  db.get()[0].archived = true;
  expect((await service.submit(e)).outcome).toBe("rejected");
  service.inspect(e.source, { ...e, attempt_id: randomUUID() });
  expect(deps.ensureRunning).not.toHaveBeenCalled();
});

test("archiving a thread during startup prevents submission", async () => {
  const { e, deps, service, db } = fixture();
  deps.ensureRunning = async () => {
    db.get()[0].archived = true;
  };
  expect((await service.submit(e)).outcome).toBe("rejected");
  expect(db.set).not.toHaveBeenCalled();
  expect(deps.admit).not.toHaveBeenCalled();
});

test("concurrent calls for the same attempt share startup and admission", async () => {
  const { e, deps, service } = fixture();
  let finish!: () => void;
  const starting = new Promise<void>((resolve) => {
    deps.ensureRunning = jest.fn(
      () =>
        new Promise<void>((started) => {
          finish = started;
          resolve();
        }),
    );
  });
  const first = service.submit(e);
  await starting;
  const second = service.submit(e);
  finish();
  const outcomes = await Promise.all([first, second]);
  expect(outcomes.map((r) => r.outcome)).toEqual(["accepted", "accepted"]);
  expect(deps.ensureRunning).toHaveBeenCalledTimes(1);
  expect(deps.admit).toHaveBeenCalledTimes(1);
});

test.each([undefined, "0", "1"])(
  "host evidence is principal scoped independently of personal flag %s",
  async (flag) => {
    const previous = process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED;
    if (flag == null)
      delete process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED;
    else process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = flag;
    try {
      const { e, deps, service } = fixture();
      const q = { ...e, account_id: randomUUID(), run_id: randomUUID() };
      expect((await service.submit(e)).outcome).toBe("accepted");
      expect(service.inspect(e.source, e, e.account_id).outcome).toBe(
        "accepted",
      );
      expect(service.inspect(e.source, e, q.account_id).outcome).toBe(
        "unknown",
      );
      expect(service.inspect(e.source, e).outcome).toBe("unknown");
      expect(deps.ensureRunning).toHaveBeenCalledTimes(1);
      deps.admit = jest.fn(async () => {
        throw new Error("lost Q acknowledgment");
      });
      expect((await service.submit(q)).outcome).toBe("unknown");
      expect(service.inspect(e.source, e, e.account_id).outcome).toBe(
        "accepted",
      );
      expect(service.inspect(e.source, e, q.account_id).outcome).toBe(
        "unknown",
      );
      await service.submit(q);
      expect(deps.admit).toHaveBeenCalledTimes(1);
      expect(deps.ensureRunning).toHaveBeenCalledTimes(2);
    } finally {
      if (previous == null)
        delete process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED;
      else process.env.COCALC_AGENT_PERSONAL_MESSAGING_ENABLED = previous;
    }
  },
);

test("inspection never falls back to legacy unscoped evidence", async () => {
  const { e, deps } = fixture();
  const attempts = new AgentRpcAttempts();
  await attempts.send(e.source, e, async () => rpcOutcome(e, "accepted"));
  const service = createAgentRpcService(deps, attempts);
  expect(attempts.inspect(e.source, e).outcome).toBe("accepted");
  expect(service.inspect(e.source, e).outcome).toBe("unknown");
  expect(service.inspect(e.source, e, e.account_id).outcome).toBe("unknown");
  expect(deps.ensureRunning).not.toHaveBeenCalled();
  expect(deps.admit).not.toHaveBeenCalled();
});

test("host admission is shared across service facades and rejects before chat or startup", async () => {
  const capacity = new AgentRpcCapacity(1, 1);
  const first = fixture(),
    second = fixture();
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  first.deps.ensureRunning = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
      entered();
    });
  const a = createAgentRpcService(first.deps, new AgentRpcAttempts(), capacity);
  const b = createAgentRpcService(
    second.deps,
    new AgentRpcAttempts(),
    capacity,
  );
  second.deps.withChat = jest.fn(second.deps.withChat);
  const pending = a.submit(first.e);
  await started;
  try {
    expect(await b.submit(second.e)).toMatchObject({
      outcome: "rejected",
      code: "host_overloaded",
      chat_effect: "none",
    });
    expect(second.deps.withChat).not.toHaveBeenCalled();
    expect(second.deps.ensureRunning).not.toHaveBeenCalled();
    expect(second.deps.admit).not.toHaveBeenCalled();
  } finally {
    finish();
  }
  await pending;
  expect(
    (await b.submit({ ...second.e, attempt_id: randomUUID() })).outcome,
  ).toBe("accepted");
});

test("startup timeout retains host capacity until the actual startup settles", async () => {
  jest.useFakeTimers();
  try {
    const { e, deps, db } = fixture();
    const capacity = new AgentRpcCapacity(1, 1);
    let finish!: () => void;
    deps.ensureRunning = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const service = createAgentRpcService(
      deps,
      new AgentRpcAttempts(),
      capacity,
    );
    e.deadline = Date.now() + 30;
    const pending = service.submit(e);
    await jest.advanceTimersByTimeAsync(31);
    expect(await pending).toMatchObject({
      code: "startup_deadline",
      chat_effect: "none",
    });
    expect(capacity.acquire("other")).toEqual({ code: "host_overloaded" });
    finish();
    await jest.advanceTimersByTimeAsync(1);
    expect("code" in capacity.acquire("other")).toBe(false);
    expect(db.set).not.toHaveBeenCalled();
    expect(deps.admit).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
