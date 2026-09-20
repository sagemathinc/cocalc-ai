import {
  CODEX_SUBSCRIPTION_SELECTION_EVENT,
  readCodexSubscriptionSelection,
  writeCodexSubscriptionSelection,
} from "../codex-subscription-selection";

describe("Codex subscription selection", () => {
  const credentialId = "00000000-0000-4000-8000-000000000001";
  beforeEach(() => localStorage.clear());

  it("isolates selections by account, project, and thread", () => {
    writeCodexSubscriptionSelection({
      accountId: "account-a",
      projectId: "project-a",
      threadKey: "thread-a",
      credentialId,
    });
    expect(
      readCodexSubscriptionSelection({
        accountId: "account-a",
        projectId: "project-a",
        threadKey: "thread-a",
      }),
    ).toBe(credentialId);
    expect(
      readCodexSubscriptionSelection({
        accountId: "account-b",
        projectId: "project-a",
        threadKey: "thread-a",
      }),
    ).toBeUndefined();
    expect(
      readCodexSubscriptionSelection({
        accountId: "account-a",
        projectId: "project-a",
        threadKey: "thread-b",
      }),
    ).toBeUndefined();
  });

  it("removes selections and notifies same-window listeners", () => {
    const listener = jest.fn();
    window.addEventListener(CODEX_SUBSCRIPTION_SELECTION_EVENT, listener);
    writeCodexSubscriptionSelection({
      accountId: "account-a",
      projectId: "project-a",
      credentialId,
    });
    writeCodexSubscriptionSelection({
      accountId: "account-a",
      projectId: "project-a",
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(
      readCodexSubscriptionSelection({
        accountId: "account-a",
        projectId: "project-a",
      }),
    ).toBeUndefined();
    window.removeEventListener(CODEX_SUBSCRIPTION_SELECTION_EVENT, listener);
  });

  it("does not persist malformed credential selectors", () => {
    writeCodexSubscriptionSelection({
      accountId: "account-a",
      projectId: "project-a",
      credentialId: "..",
    });
    expect(
      readCodexSubscriptionSelection({
        accountId: "account-a",
        projectId: "project-a",
      }),
    ).toBeUndefined();
  });
});
