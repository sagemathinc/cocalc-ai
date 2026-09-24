import {
  codexConnectionNeedsAttentionAfterSubmit,
  ensureProjectRunningForCodex,
  isCodexPaymentSourceDefinitelyUnconfigured,
  isCodexPaymentSourceNeedsUserConfiguration,
  isCodexPaymentSourceUsable,
  isCodexSubmitTarget,
  shouldUseExplicitMembershipModel,
} from "../codex-submit-preflight";

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

describe("Codex submit preflight", () => {
  it("only applies the membership model after explicit selection", () => {
    const paymentSource = {
      source: "site-api-key" as const,
      siteFundedCodex: { enabled: true },
    } as any;
    expect(
      shouldUseExplicitMembershipModel({ preference: "auto", paymentSource }),
    ).toBe(false);
    expect(
      shouldUseExplicitMembershipModel({
        preference: "site-api-key",
        paymentSource,
      }),
    ).toBe(true);
  });
  it("requires an actual payment source", () => {
    expect(isCodexPaymentSourceUsable(undefined)).toBe(false);
    expect(isCodexPaymentSourceUsable({ source: "none" } as any)).toBe(false);
    expect(isCodexPaymentSourceUsable({ source: "subscription" } as any)).toBe(
      true,
    );
  });

  it("only blocks submit preflight when the source is definitely unconfigured", () => {
    expect(isCodexPaymentSourceDefinitelyUnconfigured(undefined)).toBe(false);
    expect(
      isCodexPaymentSourceDefinitelyUnconfigured({ source: "none" } as any),
    ).toBe(true);
    expect(
      isCodexPaymentSourceDefinitelyUnconfigured({
        source: "subscription",
      } as any),
    ).toBe(false);
  });

  it("prompts for user-managed Codex credentials for site-billed sources", () => {
    expect(isCodexPaymentSourceNeedsUserConfiguration(undefined)).toBe(false);
    expect(
      isCodexPaymentSourceNeedsUserConfiguration({ source: "none" } as any),
    ).toBe(true);
    expect(
      isCodexPaymentSourceNeedsUserConfiguration({
        source: "site-api-key",
        siteAiUsageLimitPositive: false,
        siteFundedCodex: { enabled: true },
      } as any),
    ).toBe(true);
    expect(
      isCodexPaymentSourceNeedsUserConfiguration({
        source: "site-api-key",
        siteAiUsageLimitPositive: false,
      } as any),
    ).toBe(true);
    expect(
      isCodexPaymentSourceNeedsUserConfiguration({
        source: "site-api-key",
        siteAiUsageLimitPositive: true,
      } as any),
    ).toBe(false);
    expect(
      isCodexPaymentSourceNeedsUserConfiguration({
        source: "site-api-key",
      } as any),
    ).toBe(false);
    expect(
      isCodexPaymentSourceNeedsUserConfiguration({
        source: "subscription",
      } as any),
    ).toBe(false);
    expect(
      isCodexPaymentSourceNeedsUserConfiguration({
        source: "account-api-key",
      } as any),
    ).toBe(false);
  });

  it("detects new and existing Codex thread sends", () => {
    expect(isCodexSubmitTarget({ newThreadAgentMode: "codex" })).toBe(true);
    expect(isCodexSubmitTarget({ existingThreadAgentKind: "acp" })).toBe(true);
    expect(
      isCodexSubmitTarget({ existingThreadAgentModel: "gpt-5.4-codex" }),
    ).toBe(true);
  });

  it("checks subscription authentication without blocking the send path", async () => {
    const fetchPaymentSource = jest.fn(async () => ({
      source: "subscription" as const,
    }));
    const fetchUsageStatus = jest.fn(async () => ({
      success: true,
      authentication: { status: "connected" as const },
    }));

    await expect(
      codexConnectionNeedsAttentionAfterSubmit({
        fetchPaymentSource,
        fetchUsageStatus,
      }),
    ).resolves.toBe(false);
    expect(fetchUsageStatus).toHaveBeenCalledTimes(1);
  });

  it("opens credential recovery for an expired subscription", async () => {
    await expect(
      codexConnectionNeedsAttentionAfterSubmit({
        fetchPaymentSource: async () => ({ source: "subscription" }),
        fetchUsageStatus: async () => ({
          success: false,
          authentication: { status: "needs-sign-in" },
        }),
      }),
    ).resolves.toBe(true);
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
