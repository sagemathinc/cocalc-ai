/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const getMembershipMock = jest.fn();
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

jest.mock("./purchases", () => ({
  __esModule: true,
  getMembership: (...args: any[]) => getMembershipMock(...args),
}));

jest.mock("./principal-policy-denials", () => ({
  __esModule: true,
  recordHubApiPrincipalDenial: (...args: any[]) =>
    recordPrincipalDenialMock(...args),
}));

describe("hub purchases principal enforcement", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";
  const project_id = "22222222-2222-4222-8222-222222222222";
  const host_id = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    jest.resetModules();
    getMembershipMock.mockReset().mockResolvedValue({ source: "test" });
    recordPrincipalDenialMock.mockClear();
  });

  it.each([
    ["project", `hub.project.${project_id}.api`],
    ["host", `hub.host.${host_id}.api`],
  ])(
    "rejects a %s principal before purchases dispatch",
    async (_kind, subject) => {
      const { handleApiRequest } = await import("./index");
      const respond = jest.fn(async () => undefined);

      await handleApiRequest({
        request: {
          name: "purchases.getMembership",
          args: [{ account_id }],
        },
        mesg: { subject, respond },
      });

      expect(getMembershipMock).not.toHaveBeenCalled();
      expect(recordPrincipalDenialMock).toHaveBeenCalledWith({
        principal_type: _kind,
        account_id: undefined,
        project_id: _kind === "project" ? project_id : undefined,
        host_id: _kind === "host" ? host_id : undefined,
        method: "purchases.getMembership",
        required_policy: "account",
      });
      expect(respond).toHaveBeenCalledWith(null, {
        headers: {
          error: "account principal required for 'purchases.getMembership'",
          error_attrs: { code: 403, subject: undefined },
        },
      });
    },
  );

  it("overwrites a supplied account id before purchases dispatch", async () => {
    const { handleApiRequest } = await import("./index");
    const respond = jest.fn(async () => undefined);

    await handleApiRequest({
      request: {
        name: "purchases.getMembership",
        args: [{ account_id: "victim-account" }],
      },
      mesg: {
        subject: `hub.account.${account_id}.api`,
        respond,
      },
    });

    expect(getMembershipMock).toHaveBeenCalledWith({ account_id });
    expect(respond).toHaveBeenCalledWith(
      { source: "test" },
      { headers: undefined },
    );
  });
});
