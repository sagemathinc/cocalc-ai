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
  setPaymentSelectionResolver,
} from "../codex-credential-admission";
import { setClaudePoolPicker } from "../claude-pool";
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

test("an agent-message turn without a recorded subscription says how to fix it", async () => {
  setCodexCredentialAdmissionResolver(async () => ({
    source: "subscription",
    credentialPinRequired: true,
  }));
  const agentTurn = request() as any;
  agentTurn.chat.agent_rpc_execution = { version: 3 };
  await expect(pinCodexCredentialAtAdmission(agentTurn)).rejects.toThrow(
    "no payment method recorded for this account",
  );
  await expect(pinCodexCredentialAtAdmission(request())).rejects.toThrow(
    "The selected ChatGPT subscription is unavailable.",
  );
});

describe("the account's stored payment selection", () => {
  const credentialId = "00000000-0000-4000-8000-0000000000aa";
  afterEach(() => setPaymentSelectionResolver());

  test("a Codex turn with no pinned subscription uses the stored one", async () => {
    const lookup = jest.fn(async () => ({
      selection: {
        version: 1,
        provider: "codex",
        mode: "credential",
        credential_id: credentialId,
      },
    }));
    setPaymentSelectionResolver(lookup);
    setCodexCredentialAdmissionResolver(async (opts) => ({
      source: "subscription",
      credentialId: opts.credential_id,
    }));
    const admitted = await pinCodexCredentialAtAdmission(request());
    expect(lookup).toHaveBeenCalledWith({
      account_id: accountId,
      project_id: projectId,
      thread_id: "thread-1",
      provider: "codex",
    });
    expect(admitted.config).toMatchObject({
      paymentSource: "subscription-credential",
      credentialId,
    });
  });

  test("an explicit choice in the request wins and skips the lookup", async () => {
    const lookup = jest.fn();
    setPaymentSelectionResolver(lookup);
    const explicit = randomUUID();
    setCodexCredentialAdmissionResolver(async (opts) => ({
      source: "subscription",
      credentialId: opts.credential_id,
    }));
    const admitted = await pinCodexCredentialAtAdmission({
      ...request(),
      config: {
        paymentSource: "subscription" as const,
        credentialId: explicit,
      },
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(admitted.config?.credentialId).toBe(explicit);
  });

  test("an unreachable hub keeps the previous behavior", async () => {
    setPaymentSelectionResolver(async () => {
      throw new Error("no such method");
    });
    const designated = randomUUID();
    setCodexCredentialAdmissionResolver(async () => ({
      source: "subscription",
      credentialId: designated,
    }));
    const admitted = await pinCodexCredentialAtAdmission(request());
    expect(admitted.config?.credentialId).toBe(designated);
  });

  test("a Claude Code agent message is paid by the stored selection or the account default", async () => {
    const runtime = {
      version: 1 as const,
      kind: "acp" as const,
      profile: {
        version: 2 as const,
        kind: "acp" as const,
        id: "claude-code",
        revision: "0.81.1",
        cwd: "/home/user",
        executionPolicy: "full-access" as const,
        credentialMode: "project-managed" as const,
      },
    };
    const agentTurn = {
      ...request(),
      config: undefined,
      runtime,
      chat: { ...request().chat, agent_rpc_execution: { version: 3 } },
    } as any;
    setPaymentSelectionResolver(async () => ({
      default: {
        version: 1,
        provider: "claude-code",
        mode: "account-api-key",
        credential_id: credentialId,
      },
    }));
    const admitted = await pinCodexCredentialAtAdmission(agentTurn);
    expect(admitted.harness_credential).toEqual({
      version: 1,
      provider: "anthropic",
      mode: "account-api-key",
      credentialId,
    });
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

describe("Auto: the Claude subscription pool", () => {
  const picked = "00000000-0000-4000-8000-0000000000bb";
  const runtime = {
    version: 1 as const,
    kind: "acp" as const,
    profile: {
      version: 2 as const,
      kind: "acp" as const,
      id: "claude-code",
      revision: "0.81.1",
      cwd: "/home/user",
      executionPolicy: "full-access" as const,
      credentialMode: "project-managed" as const,
    },
  };
  const claudeTurn = (extra: Record<string, unknown> = {}) =>
    ({ ...request(), config: undefined, runtime, ...extra }) as any;
  afterEach(() => {
    setPaymentSelectionResolver();
    setClaudePoolPicker();
  });

  test("a turn of an Auto agent runs on the subscription the home bay picks", async () => {
    setPaymentSelectionResolver(async () => ({
      selection: {
        version: 1,
        provider: "claude-code",
        mode: "subscription-pool",
        claude_ai_connectors: false,
      },
    }));
    const picker = jest.fn(async () => ({ credential_id: picked }));
    setClaudePoolPicker(picker);
    const admitted = await pinCodexCredentialAtAdmission(claudeTurn());
    expect(picker).toHaveBeenCalledWith({
      account_id: accountId,
      target: { project_id: projectId, thread_id: "thread-1" },
    });
    expect(admitted.harness_pool).toEqual({ claude_ai_connectors: false });
    expect(admitted.harness_credential).toEqual({
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId: picked,
      claudeAiConnectors: false,
    });
  });

  test("an Auto agent message picks the same way", async () => {
    setPaymentSelectionResolver(async () => ({
      default: {
        version: 1,
        provider: "claude-code",
        mode: "subscription-pool",
      },
    }));
    setClaudePoolPicker(async () => ({ credential_id: picked }));
    const admitted = await pinCodexCredentialAtAdmission(
      claudeTurn({
        chat: { ...request().chat, agent_rpc_execution: { version: 3 } },
      }),
    );
    expect(admitted.harness_pool).toEqual({});
    expect(admitted.harness_credential?.credentialId).toBe(picked);
  });

  test("an empty pool refuses the turn", async () => {
    setPaymentSelectionResolver(async () => ({
      selection: {
        version: 1,
        provider: "claude-code",
        mode: "subscription-pool",
      },
    }));
    setClaudePoolPicker(async () => ({ empty: true }));
    await expect(pinCodexCredentialAtAdmission(claudeTurn())).rejects.toThrow(
      /Auto has no Claude subscription/,
    );
  });

  test("only admission marks a turn as Auto: a client's marker is dropped", async () => {
    const pinned = randomUUID();
    const picker = jest.fn();
    setClaudePoolPicker(picker);
    const admitted = await pinCodexCredentialAtAdmission(
      claudeTurn({
        harness_pool: {},
        harness_credential: {
          version: 1,
          provider: "anthropic",
          mode: "account-subscription",
          credentialId: pinned,
        },
      }),
    );
    expect(picker).not.toHaveBeenCalled();
    expect(admitted.harness_pool).toBeUndefined();
    expect(admitted.harness_credential?.credentialId).toBe(pinned);
    // A Codex turn too.
    setCodexCredentialAdmissionResolver(async () => ({ source: "none" }));
    const codex = await pinCodexCredentialAtAdmission({
      ...request(),
      config: { paymentSource: "auto" as const },
      harness_pool: {},
    } as any);
    expect(codex.harness_pool).toBeUndefined();
  });
});
