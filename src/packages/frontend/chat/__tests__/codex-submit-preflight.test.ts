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
  });

  it("starts and waits for a stopped project", async () => {
    let state = "opened";
    const startProject = jest.fn(async () => {
      state = "running";
      return true;
    });
    const redux = {
      getStore: (name: string) =>
        name === "projects"
          ? {
              get_state: () => state,
            }
          : {
              get_state: () => undefined,
              get: () => undefined,
            },
      getActions: () => ({
        start_project: startProject,
      }),
    };

    await ensureProjectRunningForCodex({
      project_id: "project-1",
      redux,
      timeoutMs: 1000,
    });

    expect(startProject).toHaveBeenCalledWith("project-1", {
      autostart: true,
    });
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

  it("does not submit a Codex autostart when automatic starts are disabled", async () => {
    const start_project = jest.fn();
    const redux = {
      getStore: (name: string) =>
        name === "projects"
          ? {
              get_state: () => "opened",
              getIn: () => ({ autostart_enabled: false }),
            }
          : {
              get_state: () => undefined,
              get: () => undefined,
            },
      getActions: () => ({ start_project }),
    };

    await expect(
      ensureProjectRunningForCodex({
        project_id: "project-1",
        redux,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Automatic starts are disabled");
    expect(start_project).not.toHaveBeenCalled();
  });

  it("does not submit a Codex autostart when collaborators cannot use sponsor slots", async () => {
    const start_project = jest.fn();
    const redux = {
      getStore: (name: string) =>
        name === "projects"
          ? {
              get_state: () => "opened",
              getIn: () => ({
                allow_collaborator_starts_using_sponsor: false,
                users: {
                  "owner-1": { group: "owner" },
                  "user-1": { group: "collaborator" },
                },
              }),
            }
          : {
              get_state: () => undefined,
              get: (key: string) =>
                key === "account_id"
                  ? "user-1"
                  : key === "is_admin"
                    ? false
                    : undefined,
            },
      getActions: () => ({ start_project }),
    };

    await expect(
      ensureProjectRunningForCodex({
        project_id: "project-1",
        redux,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Collaborators cannot start this project");
    expect(start_project).not.toHaveBeenCalled();
  });
});
