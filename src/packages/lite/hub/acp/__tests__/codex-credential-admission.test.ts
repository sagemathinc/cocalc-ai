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
