/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const requestMock = jest.fn(async () => ({ id: "request" }));
const decideMock = jest.fn(async () => ({ decided: true }));
const recordPrincipalDenialMock = jest.fn(async () => true);

jest.mock("@cocalc/server/accounts/security-state", () => ({
  __esModule: true,
  isAccountBannedCached: jest.fn(() => false),
  startAccountSecurityStateSyncLoop: jest.fn(),
}));

jest.mock("./ai-sessions", () => ({
  __esModule: true,
  interrupt: jest.fn(),
  interruptAll: jest.fn(),
  list: jest.fn(),
  upsertProjectHostSession: jest.fn(),
}));

jest.mock("./merge-approvals", () => ({
  __esModule: true,
  request: (...args: any[]) => requestMock(...args),
  decide: (...args: any[]) => decideMock(...args),
}));

jest.mock("./principal-policy-denials", () => ({
  __esModule: true,
  recordHubApiPrincipalDenial: (...args: any[]) =>
    recordPrincipalDenialMock(...args),
}));

describe("hub merge approval principal enforcement", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";
  const project_id = "22222222-2222-4222-8222-222222222222";
  const host_id = "33333333-3333-4333-8333-333333333333";
  const victim = "44444444-4444-4444-8444-444444444444";
  const other_project = "55555555-5555-4555-8555-555555555555";
  const fingerprint = "a".repeat(64);
  const agentSubject = `hub.agent.${account_id}.${project_id}.${fingerprint}.1.2.api`;

  beforeEach(() => {
    jest.resetModules();
    requestMock.mockClear();
    decideMock.mockClear();
    recordPrincipalDenialMock.mockClear();
  });

  async function call(subject: string, name: string, args: any[], extra = {}) {
    const { handleApiRequest } = await import("./index");
    const respond = jest.fn(async () => undefined);
    await handleApiRequest({
      request: { name, args, ...extra },
      mesg: { subject, respond },
    });
    return respond;
  }

  it.each([
    ["project", `hub.project.${project_id}.api`],
    ["host", `hub.host.${host_id}.api`],
    ["agent", agentSubject],
  ])("refuses a %s-originated decide before it runs", async (kind, subject) => {
    const respond = await call(
      subject,
      "mergeApprovals.decide",
      [
        {
          account_id,
          session_hash: "forged",
          request_id: victim,
          decision: "approve",
        },
      ],
      { auth_session_hash: "forged" },
    );
    expect(decideMock).not.toHaveBeenCalled();
    expect(recordPrincipalDenialMock).toHaveBeenCalledWith(
      expect.objectContaining({
        principal_type: kind,
        method: "mergeApprovals.decide",
        required_policy: "account",
      }),
    );
    expect(respond).toHaveBeenCalledWith(null, {
      headers: {
        error: "account principal required for 'mergeApprovals.decide'",
        error_attrs: { code: 403, subject: undefined },
      },
    });
  });

  it("binds decide to the account and its own session", async () => {
    await call(
      `hub.account.${account_id}.api`,
      "mergeApprovals.decide",
      [
        {
          account_id: victim,
          session_hash: "nominated",
          request_id: victim,
          decision: "approve",
        },
      ],
      { auth_session_hash: "browser-session" },
    );
    expect(decideMock).toHaveBeenCalledWith({
      account_id,
      session_hash: "browser-session",
      request_id: victim,
      decision: "approve",
    });

    decideMock.mockClear();
    await call(`hub.account.${account_id}.api`, "mergeApprovals.decide", [
      { session_hash: "nominated", request_id: victim, decision: "approve" },
    ]);
    // Without a session of its own, the caller can't nominate one.
    expect(decideMock).toHaveBeenCalledWith({
      account_id,
      request_id: victim,
      decision: "approve",
    });
  });

  it.each([
    ["account", `hub.account.${account_id}.api`],
    ["project", `hub.project.${project_id}.api`],
    ["host", `hub.host.${host_id}.api`],
  ])("refuses a request from a %s principal", async (kind, subject) => {
    const respond = await call(subject, "mergeApprovals.request", [
      { repo: "o/r", pr_number: 1, head_sha: "c".repeat(40) },
    ]);
    expect(requestMock).not.toHaveBeenCalled();
    expect(recordPrincipalDenialMock).toHaveBeenCalledWith(
      expect.objectContaining({
        principal_type: kind,
        method: "mergeApprovals.request",
        required_policy: "bound-agent-project",
      }),
    );
    expect(respond).toHaveBeenCalledWith(null, {
      headers: expect.objectContaining({
        error: `principal '${kind}' is not permitted for 'mergeApprovals.request' (requires bound-agent-project)`,
      }),
    });
  });

  it("binds an agent's request to its own account, project and token", async () => {
    await call(agentSubject, "mergeApprovals.request", [
      {
        repo: "o/r",
        pr_number: 1,
        head_sha: "c".repeat(40),
        account_id: victim,
        project_id: other_project,
        auth_token_fingerprint: "b".repeat(64),
        host_id,
        session_hash: "forged",
      },
    ]);
    expect(requestMock).toHaveBeenCalledWith({
      repo: "o/r",
      pr_number: 1,
      head_sha: "c".repeat(40),
      account_id,
      project_id,
      auth_actor: "agent",
      auth_token_fingerprint: fingerprint,
    });
  });
});
