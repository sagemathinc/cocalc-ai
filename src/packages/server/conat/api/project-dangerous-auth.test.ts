/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let getBrowserAuthSessionHashMock: jest.Mock;
let requireDangerousSessionAuthMock: jest.Mock;

jest.mock("@cocalc/server/conat/socketio/browser-auth-sessions", () => ({
  __esModule: true,
  getBrowserAuthSessionHash: (...args: any[]) =>
    getBrowserAuthSessionHashMock(...args),
}));

jest.mock("./dangerous-session-auth", () => ({
  __esModule: true,
  requireDangerousSessionAuth: (...args: any[]) =>
    requireDangerousSessionAuthMock(...args),
}));

describe("requireDangerousProjectMutationAuth", () => {
  beforeEach(() => {
    jest.resetModules();
    getBrowserAuthSessionHashMock = jest.fn(() => "browser-session");
    requireDangerousSessionAuthMock = jest.fn(async (opts) => ({
      session_hash: opts.session_hash,
    }));
  });

  it("uses an explicit session hash when provided", async () => {
    const { requireDangerousProjectMutationAuth } =
      await import("./project-dangerous-auth");

    await requireDangerousProjectMutationAuth({
      account_id: "acct-1",
      browser_id: "browser-1",
      session_hash: "cli-session",
    });

    expect(getBrowserAuthSessionHashMock).not.toHaveBeenCalled();
    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      session_hash: "cli-session",
      require_second_factor: true,
    });
  });

  it("resolves the browser session hash for browser callers", async () => {
    const { requireDangerousProjectMutationAuth } =
      await import("./project-dangerous-auth");

    await requireDangerousProjectMutationAuth({
      account_id: "acct-1",
      browser_id: "browser-1",
    });

    expect(getBrowserAuthSessionHashMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      browser_id: "browser-1",
    });
    expect(requireDangerousSessionAuthMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      session_hash: "browser-session",
      require_second_factor: true,
    });
  });

  it("skips auth for the trusted internal capability", async () => {
    const {
      PROJECT_DANGEROUS_INTERNAL_AUTH,
      requireDangerousProjectMutationAuth,
    } = await import("./project-dangerous-auth");

    await requireDangerousProjectMutationAuth({
      account_id: "acct-1",
      internalAuth: PROJECT_DANGEROUS_INTERNAL_AUTH,
    });

    expect(getBrowserAuthSessionHashMock).not.toHaveBeenCalled();
    expect(requireDangerousSessionAuthMock).not.toHaveBeenCalled();
  });
});
