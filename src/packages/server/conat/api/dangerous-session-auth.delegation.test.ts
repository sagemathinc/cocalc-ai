/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Fresh-auth checks run on the account's home bay, wherever they are needed.

let multiBay = true;
let homeBay = "bay-1";
const delegated = jest.fn();
const createInterBaySessionAuthClient = jest.fn(() => ({
  requireDangerousSessionAuth: delegated,
}));
const requireFreshAuthForSessionHash = jest.fn();

jest.mock("@cocalc/server/accounts/home-bay", () => ({
  remoteHomeBay: async () =>
    multiBay && homeBay !== "bay-0" ? homeBay : undefined,
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({ fabric: true }),
}));
jest.mock("@cocalc/conat/inter-bay/session-auth", () => ({
  createInterBaySessionAuthClient,
}));
jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  requireFreshAuthForSessionHash,
}));
jest.mock("@cocalc/server/conat/socketio/browser-auth-sessions", () => ({
  getBrowserAuthSessionHash: () => "",
}));
jest.mock("@cocalc/server/auth/impersonation", () => ({
  getImpersonationSessionBySessionHash: async () => undefined,
}));
jest.mock("@cocalc/server/auth/two-factor", () => ({
  hasActiveSecondFactor: async () => false,
}));

import {
  handleDelegatedSessionAuth,
  requireDangerousSessionAuth,
} from "./dangerous-session-auth";

const ACCOUNT = "1f8d5b7c-3c55-4a43-9f43-3ef8b2b2d0a1";
const SESSION = { account_id: ACCOUNT, session_hash: "s" };

beforeEach(() => {
  jest.clearAllMocks();
  multiBay = true;
  homeBay = "bay-1";
  requireFreshAuthForSessionHash.mockResolvedValue(SESSION);
});

describe("requireDangerousSessionAuth", () => {
  it("checks locally in a single-bay deployment", async () => {
    multiBay = false;
    expect(
      await requireDangerousSessionAuth({
        account_id: ACCOUNT,
        session_hash: "s",
      }),
    ).toEqual(SESSION);
    expect(createInterBaySessionAuthClient).not.toHaveBeenCalled();
  });

  it("checks locally for an account homed on this bay", async () => {
    homeBay = "bay-0";
    await requireDangerousSessionAuth({
      account_id: ACCOUNT,
      session_hash: "s",
    });
    expect(requireFreshAuthForSessionHash).toHaveBeenCalledTimes(1);
    expect(createInterBaySessionAuthClient).not.toHaveBeenCalled();
  });

  it("asks the home bay to run the same check with the same options", async () => {
    delegated.mockResolvedValue({ ok: true, session: SESSION });
    const opts = {
      account_id: ` ${ACCOUNT} `,
      browser_id: "browser",
      session_hash: "s",
      require_second_factor: "if_enabled" as const,
      allow_actor_impersonation: false,
    };
    expect(await requireDangerousSessionAuth(opts)).toEqual(SESSION);
    expect(createInterBaySessionAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({ bay_id: "bay-1" }),
    );
    expect(delegated).toHaveBeenCalledWith({ ...opts, account_id: ACCOUNT });
    expect(requireFreshAuthForSessionHash).not.toHaveBeenCalled();
  });

  it("raises the home bay's refusal with its code", async () => {
    delegated.mockResolvedValue({
      ok: false,
      error: "recent two-factor verification is required",
      attrs: { code: "fresh_auth_required" },
    });
    await expect(
      requireDangerousSessionAuth({ account_id: ACCOUNT, session_hash: "s" }),
    ).rejects.toMatchObject({
      message: "recent two-factor verification is required",
      code: "fresh_auth_required",
    });
  });
});

describe("handleDelegatedSessionAuth on the home bay", () => {
  it("runs the local check", async () => {
    homeBay = "bay-0";
    expect(
      await handleDelegatedSessionAuth({
        account_id: ACCOUNT,
        session_hash: "s",
      }),
    ).toEqual({ ok: true, session: SESSION });
  });

  it("refuses accounts homed elsewhere instead of delegating again", async () => {
    homeBay = "bay-2";
    expect(
      await handleDelegatedSessionAuth({
        account_id: ACCOUNT,
        session_hash: "s",
      }),
    ).toMatchObject({ ok: false, attrs: { code: 409 } });
    expect(createInterBaySessionAuthClient).not.toHaveBeenCalled();
    expect(requireFreshAuthForSessionHash).not.toHaveBeenCalled();
  });

  it("returns the local check's refusal", async () => {
    homeBay = "bay-0";
    requireFreshAuthForSessionHash.mockRejectedValue(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    expect(
      await handleDelegatedSessionAuth({
        account_id: ACCOUNT,
        session_hash: "s",
      }),
    ).toEqual({
      ok: false,
      error: "fresh auth is required",
      attrs: { code: "fresh_auth_required" },
    });
  });
});
