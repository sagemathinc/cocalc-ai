import { acquireClaudeController } from "./claude-controller-queue";

jest.mock("./claude-subscription-registry", () => ({
  manageClaudeControllerOwnership: jest.fn(),
}));
const options = {
  projectId: "project",
  accountId: "account",
  credentialId: "credential",
  holder: "holder",
  pollMs: 1,
  timeoutMs: 100,
};
test("only queues acquisition before native startup and retains the same holder across polls", async () => {
  const manage = jest
    .fn()
    .mockResolvedValueOnce("busy")
    .mockResolvedValueOnce("busy")
    .mockResolvedValue("acquired");
  await acquireClaudeController({ ...options, manage });
  expect(manage).toHaveBeenCalledTimes(3);
  for (const [request] of manage.mock.calls)
    expect(request).toEqual({
      projectId: "project",
      accountId: "account",
      credentialId: "credential",
      holder: "holder",
      operation: "acquire",
    });
});
test("queue waits are cancellable without launching work or selecting another credential", async () => {
  const controller = new AbortController();
  const manage = jest.fn(async () => {
    controller.abort();
    return "busy" as const;
  });
  await expect(
    acquireClaudeController({ ...options, signal: controller.signal, manage }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(manage).toHaveBeenCalledTimes(1);
});
test("unknown acquisition is not automatically retried", async () => {
  const manage = jest.fn().mockRejectedValue(Error("unknown"));
  await expect(acquireClaudeController({ ...options, manage })).rejects.toThrow(
    "unknown",
  );
  expect(manage).toHaveBeenCalledTimes(1);
});
test("released holders are never resurrected", async () => {
  await expect(
    acquireClaudeController({
      ...options,
      manage: jest.fn().mockResolvedValue("released"),
    }),
  ).rejects.toThrow("CLAUDE_CONTROLLER_FENCED");
});
test("bounded waiting returns an explicit busy reason", async () => {
  await expect(
    acquireClaudeController({
      ...options,
      timeoutMs: 0,
      manage: jest.fn().mockResolvedValue("busy"),
    }),
  ).rejects.toMatchObject({ code: "CLAUDE_CONTROLLER_BUSY" });
});
