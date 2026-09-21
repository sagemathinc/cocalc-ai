import { AgentStore } from "./store";

describe("AgentStore identity lookup", () => {
  test("treats a valid virtual agent path as an unregistered identity", async () => {
    const query = jest.fn();
    const store = new AgentStore({ query } as any);

    await expect(
      store.find("project-id", "/home/user/.agents/assistant", "thread-id"),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  test("retains strict validation for malformed paths", async () => {
    const query = jest.fn();
    const store = new AgentStore({ query } as any);

    await expect(store.find("project-id", "", "thread-id")).rejects.toThrow(
      "invalid chat path",
    );
    expect(query).not.toHaveBeenCalled();
  });

  test("normalizes and looks up persisted chat identities", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const store = new AgentStore({ query } as any);

    await expect(
      store.find("project-id", "agent.chat", "thread-id"),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      "project-id",
      "/home/user/agent.chat",
      "thread-id",
    ]);
  });
});
