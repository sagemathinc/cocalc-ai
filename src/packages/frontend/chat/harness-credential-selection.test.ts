/** @jest-environment jsdom */
import { parseAcpHarnessCredential } from "@cocalc/util/ai/runtime";
import { getQualifiedHarnessCandidate } from "@cocalc/util/ai/qualified-harnesses";
import {
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "./harness-credential-selection";

const scope = {
  accountId: "account-a",
  projectId: "project-a",
  threadKey: "thread-a",
};
const credential = {
  version: 1,
  provider: "anthropic",
  mode: "account-subscription",
  credentialId: "00000000-0000-4000-8000-000000000001",
} as const;
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
beforeEach(() => localStorage.clear());

test("connector opt-out is account-local, round-trips, and defaults on", () => {
  writeHarnessCredentialSelection({ ...scope, credential });
  expect(readHarnessCredentialSelection(scope)).toEqual(credential);
  writeHarnessCredentialSelection({
    ...scope,
    credential: { ...credential, claudeAiConnectors: false },
  });
  expect(readHarnessCredentialSelection(scope)).toEqual({
    ...credential,
    claudeAiConnectors: false,
  });
  expect(
    readHarnessCredentialSelection({
      accountId: scope.accountId,
      forNewAgent: true,
    }),
  ).toEqual({ ...credential, claudeAiConnectors: false });
  expect(
    readHarnessCredentialSelection({ ...scope, threadKey: "other-thread" })
      ?.mode,
  ).toBe("project-secret");
  expect(
    readHarnessCredentialSelection({ ...scope, accountId: "other-account" })
      ?.mode,
  ).toBe("project-secret");
  writeHarnessCredentialSelection({
    ...scope,
    credential: { ...credential, claudeAiConnectors: true },
  });
  expect(readHarnessCredentialSelection(scope)).toEqual(credential);
});

test("only subscription credentials accept a boolean connector preference", () => {
  expect(parse({ ...credential, claudeAiConnectors: false })).toEqual({
    ...credential,
    claudeAiConnectors: false,
  });
  expect(parse({ ...credential, claudeAiConnectors: true })).toEqual(
    credential,
  );
  expect(() => parse({ ...credential, claudeAiConnectors: "false" })).toThrow();
  expect(() =>
    parse({
      ...credential,
      mode: "account-api-key",
      claudeAiConnectors: false,
    }),
  ).toThrow();
});
