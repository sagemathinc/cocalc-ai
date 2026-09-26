/** @jest-environment jsdom */

import {
  HARNESS_CREDENTIAL_SELECTION_EVENT,
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "../harness-credential-selection";

describe("ACP harness credential selection", () => {
  const credentialId = "00000000-0000-4000-8000-000000000001";

  beforeEach(() => localStorage.clear());

  it("remembers a credential for new agents without changing existing agents", () => {
    const credential = {
      version: 1 as const,
      provider: "anthropic" as const,
      mode: "account-subscription" as const,
      credentialId,
    };
    writeHarnessCredentialSelection({
      accountId: "a",
      projectId: "p",
      threadKey: "t",
      credential,
    });
    expect(
      readHarnessCredentialSelection({ accountId: "a", forNewAgent: true }),
    ).toEqual(credential);
    expect(
      readHarnessCredentialSelection({
        accountId: "a",
        projectId: "other",
        threadKey: "new",
        forNewAgent: true,
      }),
    ).toEqual(credential);
    expect(
      readHarnessCredentialSelection({
        accountId: "a",
        projectId: "other",
        threadKey: "existing",
      })?.mode,
    ).toBe("project-secret");
    expect(
      readHarnessCredentialSelection({ accountId: "b", forNewAgent: true }),
    ).toBeUndefined();
    writeHarnessCredentialSelection({
      accountId: "a",
      projectId: "p",
      threadKey: "explicit",
      credential: { version: 1, provider: "anthropic", mode: "project-secret" },
    });
    expect(
      readHarnessCredentialSelection({
        accountId: "a",
        projectId: "p",
        threadKey: "t",
        forNewAgent: true,
      }),
    ).toEqual(credential);
    expect(
      readHarnessCredentialSelection({ accountId: "a", forNewAgent: true })
        ?.mode,
    ).toBe("project-secret");
  });

  it("defaults to a project secret and isolates account-key choices", () => {
    expect(
      readHarnessCredentialSelection({
        accountId: "account-a",
        projectId: "project-a",
        threadKey: "thread-a",
      }),
    ).toEqual({
      version: 1,
      provider: "anthropic",
      mode: "project-secret",
    });
    writeHarnessCredentialSelection({
      accountId: "account-a",
      projectId: "project-a",
      threadKey: "thread-a",
      credential: {
        version: 1,
        provider: "anthropic",
        mode: "account-api-key",
        credentialId,
      },
    });
    expect(
      readHarnessCredentialSelection({
        accountId: "account-a",
        projectId: "project-a",
        threadKey: "thread-a",
      }),
    ).toEqual({
      version: 1,
      provider: "anthropic",
      mode: "account-api-key",
      credentialId,
    });
    expect(
      readHarnessCredentialSelection({
        accountId: "account-b",
        projectId: "project-a",
        threadKey: "thread-a",
      })?.mode,
    ).toBe("project-secret");
  });

  it("notifies same-window controls when the next-turn choice changes", () => {
    const listener = jest.fn();
    window.addEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, listener);
    writeHarnessCredentialSelection({
      accountId: "account-a",
      projectId: "project-a",
      threadKey: "thread-a",
      credential: {
        version: 1,
        provider: "anthropic",
        mode: "project-secret",
      },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, listener);
  });

  it("keeps subscription selection account-local", () => {
    writeHarnessCredentialSelection({
      accountId: "account-a",
      projectId: "project-a",
      threadKey: "thread-a",
      credential: {
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId,
      },
    });
    expect(
      readHarnessCredentialSelection({
        accountId: "account-a",
        projectId: "project-a",
        threadKey: "thread-a",
      }),
    ).toEqual({
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId,
    });
    expect(
      readHarnessCredentialSelection({
        accountId: "account-b",
        projectId: "project-a",
        threadKey: "thread-a",
      })?.mode,
    ).toBe("project-secret");
  });
});
