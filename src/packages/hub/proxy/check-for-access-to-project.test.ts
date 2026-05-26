/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetAccountWithApiKey = jest.fn();
const mockIsCollaborator = jest.fn();
const mockStartAccountSecurityStateSyncLoop = jest.fn();
const mockEnsureAccountSecurityStateReady = jest.fn();
const mockIsAccountBannedCached = jest.fn();

jest.mock("../servers/database", () => ({
  getDatabase: jest.fn(),
}));

jest.mock("../access", () => ({
  user_has_write_access_to_project: jest.fn(),
  user_has_read_access_to_project: jest.fn(),
}));

jest.mock("../logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
  }),
  getLogger: () => ({
    debug: jest.fn(),
  }),
}));

jest.mock("@cocalc/server/api/manage", () => ({
  getAccountWithApiKey: (...args: any[]) => mockGetAccountWithApiKey(...args),
}));

jest.mock("@cocalc/server/projects/is-collaborator", () => ({
  __esModule: true,
  default: (...args: any[]) => mockIsCollaborator(...args),
}));

jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: (...args: any[]) =>
    mockEnsureAccountSecurityStateReady(...args),
  isAccountBannedCached: (...args: any[]) => mockIsAccountBannedCached(...args),
  startAccountSecurityStateSyncLoop: (...args: any[]) =>
    mockStartAccountSecurityStateSyncLoop(...args),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

describe("proxy hasAccess API key scope", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountWithApiKey.mockReset().mockResolvedValue({
      account_id: ACCOUNT_ID,
      api_key_id: 7,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:exec"],
      allowed_project_ids: [PROJECT_ID],
    });
    mockIsCollaborator.mockReset().mockResolvedValue(true);
    mockStartAccountSecurityStateSyncLoop.mockReset();
    mockEnsureAccountSecurityStateReady
      .mockReset()
      .mockResolvedValue(undefined);
    mockIsAccountBannedCached.mockReset().mockReturnValue(false);
  });

  it("allows scoped API keys for their allowed project", async () => {
    const hasAccess = (await import("./check-for-access-to-project")).default;

    await expect(
      hasAccess({
        project_id: PROJECT_ID,
        api_key: "sk_test",
        type: "write",
        isPersonal: false,
      }),
    ).resolves.toBe(true);

    expect(mockIsCollaborator).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
  });

  it("denies scoped API keys for a different collaborator project", async () => {
    const hasAccess = (await import("./check-for-access-to-project")).default;

    await expect(
      hasAccess({
        project_id: OTHER_PROJECT_ID,
        api_key: "sk_test",
        type: "write",
        isPersonal: false,
      }),
    ).resolves.toBe(false);

    expect(mockIsCollaborator).not.toHaveBeenCalled();
  });
});
