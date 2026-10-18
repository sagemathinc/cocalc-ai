import { AgentRpcCapacityError } from "./admission-capacity";

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
