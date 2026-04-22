import {
  ensureProjectRunningForCodex,
  isCodexPaymentSourceUsable,
  isCodexSubmitTarget,
} from "../codex-submit-preflight";

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

describe("Codex submit preflight", () => {
  it("requires an actual payment source", () => {
    expect(isCodexPaymentSourceUsable(undefined)).toBe(false);
    expect(isCodexPaymentSourceUsable({ source: "none" } as any)).toBe(false);
    expect(isCodexPaymentSourceUsable({ source: "subscription" } as any)).toBe(
      true,
    );
  });

  it("detects new and existing Codex thread sends", () => {
    expect(isCodexSubmitTarget({ newThreadAgentMode: "codex" })).toBe(true);
    expect(isCodexSubmitTarget({ existingThreadAgentKind: "acp" })).toBe(true);
    expect(
      isCodexSubmitTarget({ existingThreadAgentModel: "gpt-5.4-codex" }),
    ).toBe(true);
    expect(isCodexSubmitTarget({ existingThreadAgentKind: "llm" })).toBe(false);
  });

  it("starts and waits for a stopped project", async () => {
    let state = "opened";
    const startProject = jest.fn(async () => {
      state = "running";
      return true;
    });
    const redux = {
      getStore: () => ({
        get_state: () => state,
      }),
      getActions: () => ({
        start_project: startProject,
      }),
    };

    await ensureProjectRunningForCodex({
      project_id: "project-1",
      redux,
      timeoutMs: 1000,
    });

    expect(startProject).toHaveBeenCalledWith("project-1");
  });

  it("fails quickly when start_project refuses to start", async () => {
    const redux = {
      getStore: () => ({
        get_state: () => "opened",
      }),
      getActions: () => ({
        start_project: jest.fn(async () => false),
      }),
    };

    await expect(
      ensureProjectRunningForCodex({
        project_id: "project-1",
        redux,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("project did not start");
  });
});
