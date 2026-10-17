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
  },
);

test("acquireWithin takes a slot as soon as one is released", async () => {
  const capacity = new AgentRpcCapacity(1, 1);
  const first = capacity.acquire("a");
  if ("code" in first) throw Error("expected lease");
  const waiting = capacity.acquireWithin("b", 10_000);
  setTimeout(() => first.release(), 10);
  const started = Date.now();
  const lease = await waiting;
  expect("code" in lease).toBe(false);
  expect(Date.now() - started).toBeLessThan(5_000);
  if (!("code" in lease)) lease.release();
});

test("acquireWithin gives up after its wait with the counts", async () => {
  const capacity = new AgentRpcCapacity(2, 1);
  const held = capacity.acquire("a");
  const full = await capacity.acquireWithin("a", 20);
  expect(full).toEqual({ code: "project_overloaded", active: 1, limit: 1 });
  if ("code" in full) {
    expect(agentRpcCapacityReason(full)).toBe(
      "the recipient is busy (1 of 1 messages to the recipient's project are being delivered right now); retry in a few seconds",
    );
  }
  if (!("code" in held)) held.release();
  expect("code" in (await capacity.acquireWithin("a", 0))).toBe(false);
});

test("default limits allow a burst of messages to one project", () => {
  const capacity = new AgentRpcCapacity();
  for (let i = 0; i < 24; i++)
    expect("code" in capacity.acquire("a")).toBe(false);
  expect(capacity.acquire("a")).toMatchObject({ code: "project_overloaded" });
});
