import {
  CODEX_SUBSCRIPTION_SELECTION_EVENT,
  readCodexSubscriptionSelection,
  writeCodexSubscriptionSelection,
} from "../codex-subscription-selection";
import {
  createMemoryPaymentApiForTests,
  resetPaymentSelectionStoreForTests,
} from "../payment-selection-store";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Codex subscription selection", () => {
  const credentialId = "00000000-0000-4000-8000-000000000001";
  let server: ReturnType<typeof createMemoryPaymentApiForTests>;
  beforeEach(() => {
    server = createMemoryPaymentApiForTests();
    resetPaymentSelectionStoreForTests(server);
  });

  it("isolates selections by account, project, and thread", async () => {
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
        accountId: "account-a",
        projectId: "project-a",
        threadKey: "thread-b",
      }),
    ).toBeUndefined();
    await settle();
    // Another account starts from nothing in this browser.
    expect(
      readCodexSubscriptionSelection({
        accountId: "account-b",
        projectId: "project-a",
        threadKey: "thread-a",
      }),
    ).toBeUndefined();
  });

  it("is shared by every device of the account", async () => {
    // Laptop: choose a subscription.
    writeCodexSubscriptionSelection({
      accountId: "account-a",
      projectId: "project-a",
      threadKey: "thread-a",
      credentialId,
    });
    await settle();
    // Phone: a fresh browser with nothing cached, same server.
    resetPaymentSelectionStoreForTests(server);
    const listener = jest.fn();
    window.addEventListener(CODEX_SUBSCRIPTION_SELECTION_EVENT, listener);
    const scope = {
      accountId: "account-a",
      projectId: "project-a",
      threadKey: "thread-a",
    };
    expect(readCodexSubscriptionSelection(scope)).toBeUndefined();
    await settle();
    expect(listener).toHaveBeenCalled();
    expect(readCodexSubscriptionSelection(scope)).toBe(credentialId);
    window.removeEventListener(CODEX_SUBSCRIPTION_SELECTION_EVENT, listener);
  });

  it("removes selections and notifies same-window listeners", async () => {
    const listener = jest.fn();
    window.addEventListener(CODEX_SUBSCRIPTION_SELECTION_EVENT, listener);
    const scope = {
      accountId: "account-a",
      projectId: "project-a",
      threadKey: "thread-a",
    };
    writeCodexSubscriptionSelection({ ...scope, credentialId });
    writeCodexSubscriptionSelection(scope);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readCodexSubscriptionSelection(scope)).toBeUndefined();
    await settle();
    expect(server.rows.size).toBe(0);
    window.removeEventListener(CODEX_SUBSCRIPTION_SELECTION_EVENT, listener);
  });

  it("does not store malformed credential selectors", async () => {
    writeCodexSubscriptionSelection({
      accountId: "account-a",
      projectId: "project-a",
      threadKey: "thread-a",
      credentialId: "..",
    });
    await settle();
    expect(server.rows.size).toBe(0);
  });

  it("keeps an unsent conversation's choice in memory only", async () => {
    writeCodexSubscriptionSelection({
      accountId: "account-a",
      projectId: "project-a",
      credentialId,
    });
    expect(
      readCodexSubscriptionSelection({
        accountId: "account-a",
        projectId: "project-a",
      }),
    ).toBe(credentialId);
    await settle();
    expect(server.rows.size).toBe(0);
  });
});
