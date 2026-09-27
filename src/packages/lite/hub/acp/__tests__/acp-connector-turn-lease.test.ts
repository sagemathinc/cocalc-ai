import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  finalizeAcpTurnLease,
  getAcpTurnLease,
  heartbeatAcpTurnLease,
  startAcpTurnLease,
  verifyActiveAcpConnectorTurn,
} from "../../sqlite/acp-turns";

const key = {
  project_id: "project-a",
  path: "work.chat",
  message_date: "2026-09-25T00:00:00.000Z",
};
const request = {
  key,
  account_id: "human-a",
  message_id: "message-a",
  thread_id: "thread-a",
};

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
});

afterEach(() => {
  getAcpDatabase().prepare("DELETE FROM acp_turns").run();
});

afterAll(() => {
  closeAcpDatabase();
});

test("binds an active turn to the authenticated principal, not chat sender", () => {
  startAcpTurnLease({
    context: {
      ...key,
      message_id: request.message_id,
      thread_id: request.thread_id,
      sender_id: "agent-sender",
    } as any,
    approver_account_id: request.account_id,
    owner_instance_id: "worker-a",
    pid: process.pid,
  });
  expect(verifyActiveAcpConnectorTurn(request).approver_account_id).toBe(
    request.account_id,
  );
  for (const altered of [
    { ...request, account_id: "human-b" },
    { ...request, message_id: "message-b" },
    { ...request, thread_id: "thread-b" },
    { ...request, key: { ...key, project_id: "project-b" } },
  ]) {
    expect(() => verifyActiveAcpConnectorTurn(altered)).toThrow(
      "active authenticated ACP turn unavailable",
    );
  }
});

test("rejects stale and finalized leases", () => {
  startAcpTurnLease({
    context: {
      ...key,
      message_id: request.message_id,
      thread_id: request.thread_id,
      sender_id: request.account_id,
    } as any,
    approver_account_id: request.account_id,
    owner_instance_id: "worker-a",
    pid: process.pid,
  });
  const heartbeat = verifyActiveAcpConnectorTurn(request).heartbeat_at;
  expect(() =>
    verifyActiveAcpConnectorTurn({ ...request, now: heartbeat + 30_001 }),
  ).toThrow("active authenticated ACP turn unavailable");
  heartbeatAcpTurnLease({
    key,
    owner_instance_id: "worker-a",
    pid: process.pid,
  });
  finalizeAcpTurnLease({
    key,
    state: "completed",
    owner_instance_id: "worker-a",
  });
  expect(() => verifyActiveAcpConnectorTurn(request)).toThrow(
    "active authenticated ACP turn unavailable",
  );
});

test("an obsolete worker cannot refresh a replacement lease, even with a reused PID", () => {
  const context = {
    ...key,
    message_id: request.message_id,
    thread_id: request.thread_id,
    sender_id: request.account_id,
  } as any;
  for (const owner_instance_id of ["worker-a", "worker-b"]) {
    startAcpTurnLease({
      context,
      approver_account_id: request.account_id,
      owner_instance_id,
      pid: process.pid,
    });
  }
  const replacement = getAcpTurnLease(key)!;
  const clock = jest
    .spyOn(Date, "now")
    .mockReturnValue(replacement.heartbeat_at + 30_001);
  try {
    heartbeatAcpTurnLease({
      key,
      owner_instance_id: "worker-a",
      pid: process.pid,
    });
    expect(getAcpTurnLease(key)).toEqual(replacement);
    expect(() => verifyActiveAcpConnectorTurn(request)).toThrow(
      "active authenticated ACP turn unavailable",
    );
    heartbeatAcpTurnLease({
      key,
      owner_instance_id: "worker-b",
      pid: process.pid,
    });
    expect(verifyActiveAcpConnectorTurn(request).owner_instance_id).toBe(
      "worker-b",
    );
  } finally {
    clock.mockRestore();
  }
});

test.each(["completed", "error", "aborted"] as const)(
  "a stale worker cannot mark a replacement lease %s",
  (state) => {
    for (const owner_instance_id of ["worker-a", "worker-b"]) {
      startAcpTurnLease({
        context: {
          ...key,
          message_id: request.message_id,
          thread_id: request.thread_id,
        } as any,
        approver_account_id: request.account_id,
        owner_instance_id,
        pid: process.pid,
      });
    }
    const replacement = getAcpTurnLease(key);
    finalizeAcpTurnLease({ key, state, owner_instance_id: "worker-a" });
    expect(getAcpTurnLease(key)).toEqual(replacement);
    expect(verifyActiveAcpConnectorTurn(request).owner_instance_id).toBe(
      "worker-b",
    );
    finalizeAcpTurnLease({ key, state, owner_instance_id: "worker-b" });
    expect(getAcpTurnLease(key)?.state).toBe(state);
    expect(getAcpTurnLease(key)?.owner_instance_id).toBe("worker-b");
    expect(() => verifyActiveAcpConnectorTurn(request)).toThrow(
      "active authenticated ACP turn unavailable",
    );
  },
);

test.each(["completed", "error", "aborted"] as const)(
  "%s cannot be revived by a late worker heartbeat",
  (state) => {
    startAcpTurnLease({
      context: {
        ...key,
        message_id: request.message_id,
        thread_id: request.thread_id,
      } as any,
      approver_account_id: request.account_id,
      owner_instance_id: "worker-a",
      pid: process.pid,
    });
    finalizeAcpTurnLease({ key, state, owner_instance_id: "worker-a" });
    const finalized = getAcpTurnLease(key);
    heartbeatAcpTurnLease({
      key,
      owner_instance_id: "worker-a",
      pid: process.pid,
    });
    expect(getAcpTurnLease(key)).toEqual(finalized);
    expect(() => verifyActiveAcpConnectorTurn(request)).toThrow(
      "active authenticated ACP turn unavailable",
    );
  },
);
