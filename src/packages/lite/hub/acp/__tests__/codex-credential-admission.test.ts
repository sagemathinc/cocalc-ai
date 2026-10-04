/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";

// Launch preparation is covered by harness-runtime tests; here only the
// credential chosen at admission matters.
jest.mock("../harness-runtime", () => ({
  prepareHarnessRequest: (request: unknown) => request,
}));
import {
  pinCodexCredentialAtAdmission,
  setCodexCredentialAdmissionResolver,
} from "../codex-credential-admission";
import { closeAcpDatabase, initAcpDatabase } from "../../sqlite/acp-database";
import { decodeAcpJobRequest, enqueueAcpJob } from "../../sqlite/acp-jobs";

const projectId = randomUUID();
const accountId = randomUUID();

function request() {
  return {
    project_id: projectId,
    account_id: accountId,
    prompt: "continue",
    config: { paymentSource: "subscription" as const },
    chat: {
      project_id: projectId,
      path: "admission.chat",
      thread_id: "thread-1",
      parent_message_id: randomUUID(),
      message_id: randomUUID(),
      message_date: new Date().toISOString(),
      sender_id: "openai-codex-agent",
    },
  };
}

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
});

afterEach(() => {
  setCodexCredentialAdmissionResolver();
});

afterAll(() => {
  closeAcpDatabase();
});

test("a queued default turn retains the credential resolved at admission", async () => {
  const credentialA = randomUUID();
  const credentialB = randomUUID();
  let current = credentialA;
  setCodexCredentialAdmissionResolver(async () => ({
    source: "subscription",
    credentialId: current,
    credentialPinRequired: true,
  }));

  const admitted = await pinCodexCredentialAtAdmission(request());
  const queued = enqueueAcpJob(admitted);
  current = credentialB;

  expect(decodeAcpJobRequest(queued).config).toMatchObject({
    paymentSource: "subscription-credential",
    credentialId: credentialA,
  });
});

test("an unavailable designated default fails before queue admission", async () => {
  setCodexCredentialAdmissionResolver(async () => ({
    source: "none",
    unavailableReason: "Default subscription was revoked.",
    credentialPinRequired: true,
  }));

  await expect(pinCodexCredentialAtAdmission(request())).rejects.toThrow(
    "Default subscription was revoked.",
  );
});

test.each([undefined, "", "  \t\n"])(
  "rejects explicit subscription admission with a missing or blank ID (%j) before resolving a default",
  async (credentialId) => {
    const resolver = jest.fn(async () => ({
      source: "subscription",
      credentialId: randomUUID(),
    }));
    setCodexCredentialAdmissionResolver(resolver);
    await expect(
      pinCodexCredentialAtAdmission({
        ...request(),
        config: { paymentSource: "subscription-credential", credentialId },
      }),
    ).rejects.toThrow("explicit ChatGPT subscription");
    expect(resolver).not.toHaveBeenCalled();
  },
);

test("normalizes a valid explicit selector without dropping its credential ID", async () => {
  const credentialId = randomUUID();
  const resolver = jest.fn(async () => ({
    source: "subscription",
    credentialId,
  }));
  setCodexCredentialAdmissionResolver(resolver);
  const admitted = await pinCodexCredentialAtAdmission({
    ...request(),
    config: {
      paymentSource: "subscription-credential",
      credentialId: ` ${credentialId} `,
    },
  });
  expect(resolver).toHaveBeenCalledWith(
    expect.objectContaining({
      preference: "subscription",
      credential_id: credentialId,
    }),
  );
  expect(admitted.config).toMatchObject({
    paymentSource: "subscription-credential",
    credentialId,
  });
});

test("an agent message after a Claude version bump still uses the last human choice", async () => {
  const profile = (revision: string) => ({
    version: 2 as const,
    kind: "acp" as const,
    id: "claude-code",
    revision,
    cwd: "/home/user",
    executionPolicy: "full-access" as const,
    credentialMode: "project-managed" as const,
  });
  const credential = {
    version: 1 as const,
    provider: "anthropic" as const,
    mode: "account-api-key" as const,
    credentialId: randomUUID(),
  };
  const thread = `thread-${randomUUID()}`;
  const base = request();
  // A human turn admitted under the previous pin.
  enqueueAcpJob({
    ...base,
    config: undefined,
    runtime: { version: 1, kind: "acp", profile: profile("0.81.1") },
    harness_credential: credential,
    chat: { ...base.chat, thread_id: thread },
  } as any);
  const admitted = await pinCodexCredentialAtAdmission({
    ...base,
    config: undefined,
    runtime: {
      version: 1,
      kind: "acp",
      profile: profile(CLAUDE_CODE_QUALIFICATION.package.version),
    },
    chat: {
      ...base.chat,
      thread_id: thread,
      agent_rpc_execution: { version: 3 },
    },
  } as any);
  expect(admitted.harness_credential).toEqual(credential);
});
