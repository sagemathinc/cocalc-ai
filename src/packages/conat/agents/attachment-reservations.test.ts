import { createHash, randomUUID } from "node:crypto";
import { AgentAttachmentReservations } from "./attachment-reservations";
import { AgentRpcCapacity } from "./rpc-capacity";
import { rpcOutcome, type AgentRpcEnvelope } from "./rpc";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup() {
  const envelope: AgentRpcEnvelope = {
    version: 3,
    source: { project_id: randomUUID(), agent_id: randomUUID() },
    source_label: "@source",
    target: { project_id: randomUUID(), agent_id: randomUUID() },
    target_label: "@target",
    run_id: randomUUID(),
    account_id: randomUUID(),
    agent_session_id: randomUUID(),
    session_generation: randomUUID(),
    account_generation: 0,
    configured_delivery: "queued",
    guidance: false,
    permit_id: randomUUID(),
    attempt_id: randomUUID(),
    thread_id: randomUUID(),
    path: "/home/user/recv.chat",
    body: "Review these bytes",
    deadline: Date.now() + 30_000,
  };
  const data = Buffer.from([0, 255, 128, 42]);
  const metadata = {
    name: "receipt.bin",
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  const files = [{ ...metadata, data }];
  const request = { envelope, files: [metadata] };
  const authorize = jest.fn(async () => {});
  const start = jest.fn(async () => {});
  const capacity = new AgentRpcCapacity(1, 1);
  const reservations = new AgentAttachmentReservations(
    capacity,
    authorize,
    start,
  );
  const adapter = {
    stage: jest.fn(async () => ({ path: "/tmp/random/receipt.bin" })),
    submit: jest.fn(async () =>
      rpcOutcome(envelope, "accepted", { chat_effect: "saved" }),
    ),
    discard: jest.fn(async () => {}),
  };
  return {
    envelope,
    request,
    files,
    authorize,
    start,
    capacity,
    reservations,
    adapter,
  };
}

describe("attachment preparation admission", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("external reservation preserves identity and cannot be used by another installation", async () => {
    const s = setup();
    s.envelope.source = {
      kind: "external",
      account_id: s.envelope.account_id,
      agent_id: randomUUID(),
      installation_id: randomUUID(),
    };
    delete s.envelope.run_id;
    const ready = await s.reservations.prepare(s.request);
    expect(s.start).toHaveBeenCalledWith(
      expect.objectContaining({ source: s.envelope.source }),
    );
    const changed = {
      ...s.request,
      envelope: {
        ...s.envelope,
        source: { ...s.envelope.source, installation_id: randomUUID() },
      },
    };
    await expect(
      s.reservations.commit(ready.reservation_id, changed, s.files, s.adapter),
    ).rejects.toThrow("unavailable");
    expect(s.adapter.stage).not.toHaveBeenCalled();
    expect(
      await s.reservations.commit(
        ready.reservation_id,
        s.request,
        s.files,
        s.adapter,
      ),
    ).toMatchObject({ outcome: "accepted" });
  });

  test("preparation starts the project but never stages files or submits work", async () => {
    const s = setup();
    const ticket = await s.reservations.prepare(s.request);
    expect(ticket.expires_at).toBe(s.envelope.deadline);
    expect(s.start).toHaveBeenCalledTimes(1);
    expect(s.adapter.stage).not.toHaveBeenCalled();
    expect(s.adapter.submit).not.toHaveBeenCalled();
    expect(s.capacity.acquire(s.envelope.target.project_id)).toEqual({
      code: "host_overloaded",
    });
    await s.reservations.cancel(ticket.reservation_id, s.request);
    expect(s.capacity.acquire(s.envelope.target.project_id)).not.toHaveProperty(
      "code",
    );
  });

  test("overload and disallowed startup fail without file transfer", async () => {
    const s = setup();
    s.start.mockRejectedValueOnce(new Error("autostart disabled"));
    await expect(s.reservations.prepare(s.request)).rejects.toThrow(
      "autostart disabled",
    );
    const ticket = await s.reservations.prepare(s.request);
    await expect(s.reservations.prepare(s.request)).rejects.toMatchObject({
      code: "host_overloaded",
    });
    expect(s.start).toHaveBeenCalledTimes(2);
    expect(s.adapter.stage).not.toHaveBeenCalled();
    await s.reservations.cancel(ticket.reservation_id, s.request);
  });

  test("valid binary stages once and authorization is rechecked before execution", async () => {
    const s = setup();
    const ticket = await s.reservations.prepare(s.request);
    const result = await s.reservations.commit(
      ticket.reservation_id,
      s.request,
      s.files,
      s.adapter,
    );
    expect(result.outcome).toBe("accepted");
    expect(s.adapter.stage).toHaveBeenCalledWith(s.files);
    expect(s.adapter.submit).toHaveBeenCalledTimes(1);
    expect(s.adapter.discard).not.toHaveBeenCalled();
    expect(s.authorize).toHaveBeenCalledTimes(6);
    await expect(
      s.reservations.commit(
        ticket.reservation_id,
        s.request,
        s.files,
        s.adapter,
      ),
    ).rejects.toThrow("unavailable");
    expect(s.capacity.acquire(s.envelope.target.project_id)).not.toHaveProperty(
      "code",
    );
  });

  test.each([
    "run_id",
    "account_id",
    "agent_session_id",
    "session_generation",
    "attempt_id",
    "body",
  ] as const)("%s cannot change after preparation", async (key) => {
    const s = setup();
    const ticket = await s.reservations.prepare(s.request);
    const changed = {
      ...s.request,
      envelope: { ...s.envelope, [key]: randomUUID() },
    };
    await expect(
      s.reservations.commit(ticket.reservation_id, changed, s.files, s.adapter),
    ).rejects.toThrow("unavailable");
    expect(s.adapter.stage).not.toHaveBeenCalled();
    await s.reservations.cancel(ticket.reservation_id, s.request);
  });

  test("changed metadata or bytes cannot become a text-only send", async () => {
    const s = setup();
    const ticket = await s.reservations.prepare(s.request);
    await expect(
      s.reservations.commit(
        ticket.reservation_id,
        { ...s.request, files: [{ ...s.request.files[0], name: "different" }] },
        s.files,
        s.adapter,
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      s.reservations.commit(
        ticket.reservation_id,
        s.request,
        [{ ...s.files[0], data: Buffer.alloc(4) }],
        s.adapter,
      ),
    ).rejects.toThrow("digest");
    expect(s.adapter.stage).not.toHaveBeenCalled();
    expect(s.adapter.submit).not.toHaveBeenCalled();
  });

  test("lost preparation acknowledgment expires without executing anything", async () => {
    const s = setup();
    const ticket = await s.reservations.prepare(s.request);
    await jest.advanceTimersByTimeAsync(30_001);
    await expect(
      s.reservations.commit(
        ticket.reservation_id,
        s.request,
        s.files,
        s.adapter,
      ),
    ).rejects.toThrow("unavailable");
    expect(s.adapter.submit).not.toHaveBeenCalled();
    expect(s.capacity.acquire(s.envelope.target.project_id)).not.toHaveProperty(
      "code",
    );
  });

  test("expiry cannot free capacity while startup remains in progress", async () => {
    const s = setup(),
      start = deferred();
    s.start.mockImplementationOnce(() => start.promise);
    const prepared = s.reservations.prepare(s.request);
    const rejected = expect(prepared).rejects.toThrow("expired");
    await jest.advanceTimersByTimeAsync(30_001);
    await rejected;
    expect(s.capacity.acquire(s.envelope.target.project_id)).toEqual({
      code: "host_overloaded",
    });
    start.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(s.capacity.acquire(s.envelope.target.project_id)).not.toHaveProperty(
      "code",
    );
    expect(s.adapter.submit).not.toHaveBeenCalled();
  });

  test("a revocation during staging removes files and prevents execution", async () => {
    const s = setup();
    const ticket = await s.reservations.prepare(s.request);
    s.adapter.stage.mockImplementationOnce(async () => {
      s.authorize.mockRejectedValue(new Error("grant_revoked"));
      return { path: "/tmp/random/receipt.bin" };
    });
    await expect(
      s.reservations.commit(
        ticket.reservation_id,
        s.request,
        s.files,
        s.adapter,
      ),
    ).rejects.toThrow("grant_revoked");
    expect(s.adapter.discard).toHaveBeenCalledTimes(1);
    expect(s.adapter.submit).not.toHaveBeenCalled();
  });

  test("expiry during file I/O retains the slot until cleanup and prevents late execution", async () => {
    const s = setup(),
      staged = deferred();
    const ticket = await s.reservations.prepare(s.request);
    s.adapter.stage.mockImplementationOnce(async () => {
      await staged.promise;
      return { path: "/tmp/random/receipt.bin" };
    });
    const committing = s.reservations.commit(
      ticket.reservation_id,
      s.request,
      s.files,
      s.adapter,
    );
    const rejected = expect(committing).rejects.toThrow("expired");
    await jest.advanceTimersByTimeAsync(30_001);
    expect(s.capacity.acquire(s.envelope.target.project_id)).toEqual({
      code: "host_overloaded",
    });
    staged.resolve();
    await rejected;
    expect(s.adapter.discard).toHaveBeenCalledTimes(1);
    expect(s.adapter.submit).not.toHaveBeenCalled();
    expect(s.capacity.acquire(s.envelope.target.project_id)).not.toHaveProperty(
      "code",
    );
  });

  test("shutdown releases abandoned preparations but never starts work", async () => {
    const s = setup();
    const ticket = await s.reservations.prepare(s.request);
    s.reservations.close();
    await expect(
      s.reservations.commit(
        ticket.reservation_id,
        s.request,
        s.files,
        s.adapter,
      ),
    ).rejects.toThrow("unavailable");
    expect(s.adapter.submit).not.toHaveBeenCalled();
    expect(s.capacity.acquire(s.envelope.target.project_id)).not.toHaveProperty(
      "code",
    );
  });

  test("invalid acknowledgment is ambiguous, never permission to discard files", async () => {
    const s = setup();
    const ticket = await s.reservations.prepare(s.request);
    s.adapter.submit.mockResolvedValueOnce({
      ...rpcOutcome(s.envelope, "accepted"),
      attempt_id: randomUUID(),
    });
    await expect(
      s.reservations.commit(
        ticket.reservation_id,
        s.request,
        s.files,
        s.adapter,
      ),
    ).rejects.toThrow("mismatched");
    expect(s.adapter.discard).not.toHaveBeenCalled();
    expect(s.adapter.submit).toHaveBeenCalledTimes(1);
  });

  test.each(["unknown", "accepted"] as const)(
    "%s keeps files for possibly accepted work",
    async (outcome) => {
      const s = setup();
      const ticket = await s.reservations.prepare(s.request);
      s.adapter.submit.mockResolvedValueOnce(rpcOutcome(s.envelope, outcome));
      await s.reservations.commit(
        ticket.reservation_id,
        s.request,
        s.files,
        s.adapter,
      );
      expect(s.adapter.discard).not.toHaveBeenCalled();
    },
  );

  test("known rejection with no chat effect discards staged files", async () => {
    const s = setup();
    const ticket = await s.reservations.prepare(s.request);
    s.adapter.submit.mockResolvedValueOnce(
      rpcOutcome(s.envelope, "rejected", { chat_effect: "none" }),
    );
    await s.reservations.commit(
      ticket.reservation_id,
      s.request,
      s.files,
      s.adapter,
    );
    expect(s.adapter.discard).toHaveBeenCalledTimes(1);
  });

  test("lost submission acknowledgment neither deletes files nor retries", async () => {
    const s = setup();
    const ticket = await s.reservations.prepare(s.request);
    s.adapter.submit.mockRejectedValueOnce(new Error("ack lost"));
    await expect(
      s.reservations.commit(
        ticket.reservation_id,
        s.request,
        s.files,
        s.adapter,
      ),
    ).rejects.toThrow("ack lost");
    expect(s.adapter.discard).not.toHaveBeenCalled();
    expect(s.adapter.submit).toHaveBeenCalledTimes(1);
  });

  test("concurrent duplicate commits cannot enter staging twice", async () => {
    const s = setup(),
      staged = deferred();
    const ticket = await s.reservations.prepare(s.request);
    s.adapter.stage.mockImplementationOnce(async () => {
      await staged.promise;
      return { path: "/tmp/random/receipt.bin" };
    });
    const first = s.reservations.commit(
      ticket.reservation_id,
      s.request,
      s.files,
      s.adapter,
    );
    await expect(
      s.reservations.commit(
        ticket.reservation_id,
        s.request,
        s.files,
        s.adapter,
      ),
    ).rejects.toThrow("unavailable");
    staged.resolve();
    await first;
    expect(s.adapter.stage).toHaveBeenCalledTimes(1);
  });
});
