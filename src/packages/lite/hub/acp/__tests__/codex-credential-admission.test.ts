/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
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

test("an agent message refuses a turn nothing can pay for, before queueing", async () => {
  setCodexCredentialAdmissionResolver(async () => ({ source: "none" }));
  const agentMessage = {
    ...request(),
    config: { paymentSource: "auto" as const },
    chat: { ...request().chat, agent_rpc_execution: {} as any },
  };
  await expect(pinCodexCredentialAtAdmission(agentMessage)).rejects.toThrow(
    "[agent-recipient-setup:codex-connection]",
  );
  // A person's own turn keeps its existing behavior and error text.
  const own = { ...request(), config: { paymentSource: "auto" as const } };
  await expect(pinCodexCredentialAtAdmission(own)).resolves.toBe(own);
});
