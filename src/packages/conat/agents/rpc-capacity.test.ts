import { AgentRpcCapacity, agentRpcCapacityReason } from "./rpc-capacity";

test("host and project limits are independent and non-waiting", () => {
  const capacity = new AgentRpcCapacity(3, 2);
  const a = capacity.acquire("a"),
    b = capacity.acquire("a");
  expect(capacity.acquire("a")).toEqual({
    code: "project_overloaded",
    active: 2,
    limit: 2,
  });
  const c = capacity.acquire("b");
  expect(capacity.acquire("c")).toMatchObject({ code: "host_overloaded" });
  if ("code" in a || "code" in b || "code" in c) throw Error("expected leases");
  a.release();
  a.release();
  const d = capacity.acquire("a");
  expect("code" in d).toBe(false);
  expect(capacity.acquire("c")).toMatchObject({ code: "host_overloaded" });
  b.release();
  c.release();
  if (!("code" in d)) d.release();
});

test.each([false, true])(
  "release retains capacity until tracked work settles (reject=%s)",
  async (reject) => {
    const capacity = new AgentRpcCapacity(1, 1);
    const lease = capacity.acquire("a");
    if ("code" in lease) throw Error("expected lease");
    let finish!: () => void;
    const work = lease
      .track(
        new Promise<void>((resolve, fail) => {
          finish = () => (reject ? fail(Error("start failed")) : resolve());
        }),
      )
      .catch(() => {});
    lease.release();
    expect(capacity.acquire("b")).toMatchObject({ code: "host_overloaded" });
    finish();
    await work;
    expect("code" in capacity.acquire("b")).toBe(false);
  },
);

test.each([0, -1, Infinity, 1.5, NaN])(
  "invalid limits fail closed: %s",
  (limit) => {
    expect(() => new AgentRpcCapacity(limit)).toThrow();
    expect(() => new AgentRpcCapacity(4, limit)).toThrow();
    expect(() => new AgentRpcCapacity(4, 2, limit)).toThrow();
    expect(() => new AgentRpcCapacity(4, 2, 2, limit)).toThrow();
  },
);

test("a full scope reports its counts and a reason", () => {
  const capacity = new AgentRpcCapacity(2, 1);
  const held = capacity.acquire("a");
  const full = capacity.acquire("a");
  expect(full).toEqual({ code: "project_overloaded", active: 1, limit: 1 });
  if ("code" in full)
    expect(agentRpcCapacityReason(full)).toBe(
      "the recipient is busy (1 of 1 messages to the recipient's project are being delivered right now); retry in a few seconds",
    );
  if (!("code" in held)) held.release();
});

test("sends with attachments have tighter limits of their own", () => {
  const capacity = new AgentRpcCapacity(10, 10, 2, 1);
  const a = capacity.acquire("a", { attachments: true });
  expect("code" in a).toBe(false);
  const full = capacity.acquire("a", { attachments: true });
  expect(full).toEqual({
    code: "project_overloaded",
    active: 1,
    limit: 1,
    attachments: true,
  });
  if ("code" in full)
    expect(agentRpcCapacityReason(full)).toContain("messages with attachments");
  // Text-only sends are not held back by the attachment limit.
  expect("code" in capacity.acquire("a")).toBe(false);
  expect("code" in capacity.acquire("b", { attachments: true })).toBe(false);
  expect(capacity.acquire("c", { attachments: true })).toMatchObject({
    code: "host_overloaded",
    attachments: true,
  });
  if (!("code" in a)) a.release();
  expect("code" in capacity.acquire("c", { attachments: true })).toBe(false);
});

test("default limits allow a burst of messages to one project", () => {
  const capacity = new AgentRpcCapacity();
  for (let i = 0; i < 24; i++)
    expect("code" in capacity.acquire("a")).toBe(false);
  expect(capacity.acquire("a")).toMatchObject({ code: "project_overloaded" });
});
