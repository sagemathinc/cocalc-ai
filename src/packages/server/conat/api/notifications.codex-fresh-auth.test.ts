/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const assertProjectAccessMock = jest.fn();
const getBrowserSessionMock = jest.fn();
const resolveAccountHomeBayMock = jest.fn();
const startLocalMock = jest.fn();
const getStatusLocalMock = jest.fn();
const registerAttentionMock = jest.fn();
const startRemoteMock = jest.fn();
const getStatusRemoteMock = jest.fn();
const poolQueryMock = jest.fn();

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  assertProjectCollaboratorAccessAllowRemote: (...args: any[]) =>
    assertProjectAccessMock(...args),
}));
jest.mock("@cocalc/server/conat/socketio/browser-auth-sessions", () => ({
  getBrowserAuthSessionHash: (...args: any[]) => getBrowserSessionMock(...args),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args: any[]) => resolveAccountHomeBayMock(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-1",
}));
jest.mock("@cocalc/server/auth/cli-auth", () => ({
  normalizeCodexFreshAuthAttentionContext: (value: any) => value,
  startCodexFreshAuthChallengeLocal: (...args: any[]) =>
    startLocalMock(...args),
  getCodexFreshAuthActionStatus: (...args: any[]) =>
    getStatusLocalMock(...args),
}));
jest.mock("@cocalc/server/auth/codex-attention", () => ({
  codexFreshAuthAttentionEnabled: () => true,
  registerCodexFreshAuthAttention: (...args: any[]) =>
    registerAttentionMock(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({ client: true }),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: () => ({
    startCodexFreshAuth: (...args: any[]) => startRemoteMock(...args),
    getCodexFreshAuthStatus: (...args: any[]) => getStatusRemoteMock(...args),
  }),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => poolQueryMock(...args) }),
}));

import {
  getCodexFreshAuthActionStatus,
  startCodexFreshAuthAction,
} from "./notifications";

const ACCOUNT_ID = "00000000-1000-4000-8000-000000000001";
const PROJECT_ID = "00000000-2000-4000-8000-000000000002";
const CHALLENGE_ID = "00000000-3000-4000-8000-000000000003";
const HOST_ID = "00000000-4000-4000-8000-000000000004";
const EXPIRES_AT = new Date("2099-09-02T01:00:00.000Z");
const CONTEXT = {
  project_id: PROJECT_ID,
  path: "agent.chat",
  thread_id: "thread-1",
  purpose: "host delete",
};

describe("Codex fresh-auth action routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertProjectAccessMock.mockResolvedValue(undefined);
    getBrowserSessionMock.mockReturnValue("browser-session-hash");
    resolveAccountHomeBayMock.mockResolvedValue({ home_bay_id: "bay-1" });
    startLocalMock.mockResolvedValue({
      challenge_id: CHALLENGE_ID,
      state: "pending",
      expires_at: EXPIRES_AT,
    });
    getStatusLocalMock.mockResolvedValue({
      challenge_id: CHALLENGE_ID,
      state: "approved",
      expires_at: EXPIRES_AT,
    });
    startRemoteMock.mockResolvedValue({
      challenge_id: CHALLENGE_ID,
      state: "pending",
      expires_at: EXPIRES_AT.toISOString(),
    });
    getStatusRemoteMock.mockResolvedValue({
      challenge_id: CHALLENGE_ID,
      state: "approved",
      expires_at: EXPIRES_AT.toISOString(),
    });
    registerAttentionMock.mockResolvedValue(undefined);
    poolQueryMock.mockResolvedValue({ rowCount: 1 });
  });

  it("targets the originating browser session and registers the action", async () => {
    await expect(
      startCodexFreshAuthAction({
        account_id: ACCOUNT_ID,
        source_project_id: PROJECT_ID,
        browser_id: "browser-1",
        context: CONTEXT,
      }),
    ).resolves.toEqual({
      challenge_id: CHALLENGE_ID,
      state: "pending",
      expires_at: EXPIRES_AT.toISOString(),
    });
    expect(getBrowserSessionMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      browser_id: "browser-1",
    });
    expect(startLocalMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      session_hash: "browser-session-hash",
      duration: undefined,
      context: CONTEXT,
    });
    expect(registerAttentionMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      challenge_id: CHALLENGE_ID,
      context: CONTEXT,
    });
  });

  it("routes challenge creation and status to the account home bay", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({ home_bay_id: "bay-2" });
    await startCodexFreshAuthAction({
      account_id: ACCOUNT_ID,
      source_project_id: PROJECT_ID,
      browser_id: "browser-1",
      context: CONTEXT,
    });
    expect(startRemoteMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      target_session_hash: "browser-session-hash",
      duration: undefined,
      context: CONTEXT,
    });
    expect(startLocalMock).not.toHaveBeenCalled();

    await expect(
      getCodexFreshAuthActionStatus({
        account_id: ACCOUNT_ID,
        source_project_id: PROJECT_ID,
        challenge_id: CHALLENGE_ID,
      }),
    ).resolves.toMatchObject({
      challenge_id: CHALLENGE_ID,
      state: "approved",
      expires_at: EXPIRES_AT.toISOString(),
    });
    expect(getStatusRemoteMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      challenge_id: CHALLENGE_ID,
    });
  });

  it("binds host status reconciliation to the source project and account", async () => {
    await expect(
      getCodexFreshAuthActionStatus({
        account_id: ACCOUNT_ID,
        host_id: HOST_ID,
        source_project_id: PROJECT_ID,
        challenge_id: CHALLENGE_ID,
      }),
    ).resolves.toMatchObject({
      challenge_id: CHALLENGE_ID,
      state: "approved",
    });
    expect(poolQueryMock).toHaveBeenCalledWith(expect.any(String), [
      PROJECT_ID,
      HOST_ID,
      ACCOUNT_ID,
    ]);
    expect(assertProjectAccessMock).not.toHaveBeenCalled();
  });

  it("rejects status reconciliation from a host that does not own the project", async () => {
    poolQueryMock.mockResolvedValue({ rowCount: 0 });
    await expect(
      getCodexFreshAuthActionStatus({
        account_id: ACCOUNT_ID,
        host_id: HOST_ID,
        source_project_id: PROJECT_ID,
        challenge_id: CHALLENGE_ID,
      }),
    ).rejects.toThrow("host is not authorized");
    expect(getStatusLocalMock).not.toHaveBeenCalled();
  });

  it("does not create a challenge without the bound browser session", async () => {
    getBrowserSessionMock.mockReturnValue(undefined);
    await expect(
      startCodexFreshAuthAction({
        account_id: ACCOUNT_ID,
        source_project_id: PROJECT_ID,
        browser_id: "browser-1",
        context: CONTEXT,
      }),
    ).rejects.toThrow("originating browser tab open");
    expect(startLocalMock).not.toHaveBeenCalled();
    expect(startRemoteMock).not.toHaveBeenCalled();
    expect(registerAttentionMock).not.toHaveBeenCalled();
  });

  it("rejects a context for a different project", async () => {
    await expect(
      startCodexFreshAuthAction({
        account_id: ACCOUNT_ID,
        source_project_id: PROJECT_ID,
        browser_id: "browser-1",
        context: {
          ...CONTEXT,
          project_id: "00000000-9000-4000-8000-000000000009",
        },
      }),
    ).rejects.toThrow("project mismatch");
    expect(getBrowserSessionMock).not.toHaveBeenCalled();
  });
});
