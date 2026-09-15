import { randomUUID } from "node:crypto";
import { encodeRuntimeSponsorDenial } from "@cocalc/util/runtime-sponsor-denial";
import {
  createAgentRpcService,
  type AgentRpcExecutionAdapter,
} from "../agent-rpc-service";
import type { AgentRpcEnvelope } from "@cocalc/conat/agents/rpc";

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
  expect(service.inspect(e.source, e).outcome).toBe("accepted");
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
  expect(service.inspect(e.source, e).outcome).toBe("unknown");
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
    expect(service.inspect(e.source, e).outcome).toBe("unknown");
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
