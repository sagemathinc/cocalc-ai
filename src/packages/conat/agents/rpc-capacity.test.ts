import { AgentRpcCapacity } from "./rpc-capacity";

test("host and project limits are independent and non-waiting", () => {
  const capacity = new AgentRpcCapacity(3, 2);
  const a = capacity.acquire("a"),
    b = capacity.acquire("a");
  expect(capacity.acquire("a")).toEqual({ code: "project_overloaded" });
  const c = capacity.acquire("b");
  expect(capacity.acquire("c")).toEqual({ code: "host_overloaded" });
  if ("code" in a || "code" in b || "code" in c) throw Error("expected leases");
  a.release();
  a.release();
  const d = capacity.acquire("a");
  expect("code" in d).toBe(false);
  expect(capacity.acquire("c")).toEqual({ code: "host_overloaded" });
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
    expect(capacity.acquire("b")).toEqual({ code: "host_overloaded" });
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
