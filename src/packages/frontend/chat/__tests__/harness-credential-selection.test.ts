/** @jest-environment jsdom */
import { parseAcpHarnessCredential } from "@cocalc/util/ai/runtime";
import { getQualifiedHarnessCandidate } from "@cocalc/util/ai/qualified-harnesses";
import {
  HARNESS_CREDENTIAL_SELECTION_EVENT,
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "../harness-credential-selection";
import {
  copyPaymentSelection,
  createMemoryPaymentApiForTests,
  migrateLocalStorage,
  resetPaymentSelectionStoreForTests,
  writePaymentSelection,
} from "../payment-selection-store";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const PROJECT = "10000000-0000-4000-8000-000000000000";
const scope = {
  accountId: "account-a",
  projectId: PROJECT,
  threadKey: "thread-a",
};
const subscription = (credentialId: string) =>
  ({
    version: 1,
    provider: "anthropic",
    mode: "account-subscription",
    credentialId,
  }) as const;

let server: ReturnType<typeof createMemoryPaymentApiForTests>;
beforeEach(() => {
  localStorage.clear();
  server = createMemoryPaymentApiForTests();
  resetPaymentSelectionStoreForTests(server);
});

describe("Claude credential selection", () => {
  it("the first choice becomes the account default, which agents follow", async () => {
    writeHarnessCredentialSelection({ ...scope, credential: subscription(A) });
    await settle();
    expect(readHarnessCredentialSelection(scope)).toEqual(subscription(A));
    // The agent follows the default rather than pinning it.
    expect(server.rows.get(`thread:${PROJECT}:thread-a:claude-code`)).toBe(
      undefined,
    );
    expect(server.rows.get("default:claude-code")).toMatchObject({
      mode: "account-subscription",
      credential_id: A,
    });
    // New agents start from the default.
    expect(
      readHarnessCredentialSelection({
        accountId: "account-a",
        forNewAgent: true,
      }),
    ).toEqual(subscription(A));
  });

  it("a later choice pins only that agent; changing the default moves followers", async () => {
    writeHarnessCredentialSelection({ ...scope, credential: subscription(A) });
    const other = { ...scope, threadKey: "thread-b" };
    writeHarnessCredentialSelection({ ...other, credential: subscription(B) });
    await settle();
    expect(readHarnessCredentialSelection(other)).toEqual(subscription(B));
    expect(readHarnessCredentialSelection(scope)).toEqual(subscription(A));
    // Out of credit on A: switch the default to B; thread-a follows.
    await server.setPaymentSelections({
      defaults: ["claude-code"],
      selection: {
        version: 1,
        provider: "claude-code",
        mode: "account-subscription",
        credential_id: B,
      },
    });
    resetPaymentSelectionStoreForTests(server);
    readHarnessCredentialSelection(scope);
    await settle();
    expect(readHarnessCredentialSelection(scope)).toEqual(subscription(B));
  });

  it("connector opt-out round-trips per agent", async () => {
    writeHarnessCredentialSelection({ ...scope, credential: subscription(A) });
    writeHarnessCredentialSelection({
      ...scope,
      credential: { ...subscription(A), claudeAiConnectors: false },
    });
    await settle();
    expect(readHarnessCredentialSelection(scope)).toEqual({
      ...subscription(A),
      claudeAiConnectors: false,
    });
  });

  it("is isolated by account and defaults to the project secret", async () => {
    writeHarnessCredentialSelection({ ...scope, credential: subscription(A) });
    await settle();
    expect(
      readHarnessCredentialSelection({ ...scope, accountId: "account-b" })
        ?.mode,
    ).toBe("project-secret");
    expect(
      readHarnessCredentialSelection({
        accountId: "account-b",
        forNewAgent: true,
      }),
    ).toBeUndefined();
  });

  it("notifies same-window controls when the next-turn choice changes", () => {
    const listener = jest.fn();
    window.addEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, listener);
    writeHarnessCredentialSelection({
      ...scope,
      credential: { version: 1, provider: "anthropic", mode: "project-secret" },
    });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener(HARNESS_CREDENTIAL_SELECTION_EVENT, listener);
  });

  it("forks and fresh conversations keep the choice", async () => {
    writeHarnessCredentialSelection({ ...scope, credential: subscription(A) });
    writeHarnessCredentialSelection({ ...scope, credential: subscription(B) });
    await settle();
    await copyPaymentSelection({
      accountId: "account-a",
      from: { project_id: PROJECT, thread_id: "thread-a" },
      to: { project_id: PROJECT, thread_id: "thread-fork" },
    });
    resetPaymentSelectionStoreForTests(server);
    const fork = { ...scope, threadKey: "thread-fork" };
    readHarnessCredentialSelection(fork);
    await settle();
    expect(readHarnessCredentialSelection(fork)).toEqual(subscription(B));
  });

  it("a slow load never overwrites a newer local choice", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      ...server,
      getPaymentSelections: async (opts) => {
        const result = await server.getPaymentSelections(opts);
        await gate;
        return result;
      },
    };
    resetPaymentSelectionStoreForTests(slow as any);
    readHarnessCredentialSelection(scope); // starts a load (nothing stored)
    await settle();
    void writePaymentSelection({
      ...scope,
      provider: "claude-code",
      selection: {
        version: 1,
        provider: "claude-code",
        mode: "account-api-key",
        credential_id: A,
      },
    });
    release();
    await settle();
    expect(readHarnessCredentialSelection(scope)?.mode).toBe("account-api-key");
  });
});

describe("migration from browser storage", () => {
  it("uploads only missing choices, then forgets them locally", async () => {
    const prefix = "cocalc:acp-harness-credential:v1:account-a";
    localStorage.setItem(
      `${prefix}:${PROJECT}:thread-a`,
      `account-subscription:${A}`,
    );
    localStorage.setItem(
      `${prefix}:${PROJECT}:thread-a:claude-ai-connectors`,
      "off",
    );
    localStorage.setItem(
      `${prefix}:${PROJECT}:thread-b`,
      `account-api-key:${A}`,
    );
    localStorage.setItem(`${prefix}:default`, `account-subscription:${B}`);
    localStorage.setItem(
      `cocalc:codex-subscription:v1:account-a:${PROJECT}:thread-c`,
      A,
    );
    localStorage.setItem(`${prefix}:${PROJECT}:new`, "project-secret");
    // Another device already chose for thread-b; that choice must win.
    await server.setPaymentSelections({
      targets: [{ project_id: PROJECT, thread_id: "thread-b" }],
      selection: {
        version: 1,
        provider: "claude-code",
        mode: "account-subscription",
        credential_id: B,
      },
    });
    await migrateLocalStorage("account-a");
    expect(server.rows.get(`thread:${PROJECT}:thread-a:claude-code`)).toEqual({
      version: 1,
      provider: "claude-code",
      mode: "account-subscription",
      credential_id: A,
      claude_ai_connectors: false,
    });
    expect(
      server.rows.get(`thread:${PROJECT}:thread-b:claude-code`),
    ).toMatchObject({
      credential_id: B,
    });
    expect(server.rows.get(`thread:${PROJECT}:thread-c:codex`)).toEqual({
      version: 1,
      provider: "codex",
      mode: "credential",
      credential_id: A,
    });
    expect(server.rows.get("default:claude-code")).toMatchObject({
      credential_id: B,
    });
    expect(localStorage.length).toBe(0);
  });

  it("keeps local choices when the upload fails", async () => {
    const failing = {
      ...server,
      setPaymentSelections: async () => {
        throw new Error("offline");
      },
    };
    resetPaymentSelectionStoreForTests(failing as any);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const storageKey = `cocalc:codex-subscription:v1:account-a:${PROJECT}:thread-c`;
    localStorage.setItem(storageKey, A);
    await migrateLocalStorage("account-a");
    expect(localStorage.getItem(storageKey)).toBe(A);
    warn.mockRestore();
  });
});

test("only subscription credentials accept a boolean connector preference", () => {
  const parse = (value: unknown) =>
    parseAcpHarnessCredential(value, {
      version: 2,
      kind: "acp",
      id: "claude-code",
      cwd: "/home/user",
      revision: getQualifiedHarnessCandidate("claude-code")!.package.version,
      executionPolicy: "full-access",
      credentialMode: "project-managed",
    });
  const credential = subscription(A);
  expect(parse({ ...credential, claudeAiConnectors: false })).toEqual({
    ...credential,
    claudeAiConnectors: false,
  });
  expect(parse({ ...credential, claudeAiConnectors: true })).toEqual(
    credential,
  );
  expect(() => parse({ ...credential, claudeAiConnectors: "false" })).toThrow();
});
