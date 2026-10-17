import { AgentRpcCapacityError, admitWithin } from "./admission-capacity";

const full = () => new AgentRpcCapacityError("recipient", "permit", 4, 4);

test("capacity errors keep their legacy messages and explain the counts", () => {
  expect(full().message).toBe("recipient project messaging capacity full");
  expect(new AgentRpcCapacityError("sender", "preparation", 8, 8).message).toBe(
    "agent RPC principal capacity full",
  );
  expect(new AgentRpcCapacityError("bay", "permit", 1, 1).message).toBe(
    "too many in-flight submissions",
  );
  expect(full().reason).toBe(
    "the recipient is busy (4 of 4 messages to the recipient's project are being delivered right now); retry in a few seconds",
  );
});

test("admitWithin retries only capacity errors, within its wait", async () => {
  const create = jest
    .fn()
    .mockRejectedValueOnce(full())
    .mockResolvedValueOnce(undefined);
  await admitWithin(2_000, "state", create);
  expect(create).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledWith("state");

  const broken = jest.fn().mockRejectedValue(new Error("database down"));
  await expect(admitWithin(2_000, "state", broken)).rejects.toThrow(
    "database down",
  );
  expect(broken).toHaveBeenCalledTimes(1);

  const busy = jest.fn().mockRejectedValue(full());
  const started = Date.now();
  await expect(admitWithin(600, "state", busy)).rejects.toBeInstanceOf(
    AgentRpcCapacityError,
  );
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(busy.mock.calls.length).toBeGreaterThan(1);

  const noWait = jest.fn().mockRejectedValue(full());
  await expect(admitWithin(0, "state", noWait)).rejects.toThrow();
  expect(noWait).toHaveBeenCalledTimes(1);
});
