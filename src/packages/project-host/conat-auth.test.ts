const mockVerifyProjectHostAuthToken = jest.fn();
const mockGetProject = jest.fn();
const mockGetAccountRevokedBeforeMs = jest.fn(() => undefined);

jest.mock("@cocalc/conat/auth/project-host-token", () => ({
  verifyProjectHostAuthToken: (...args: any[]) =>
    mockVerifyProjectHostAuthToken(...args),
}));

jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: jest.fn(() => ({ users: {} })),
}));

jest.mock("./auth-public-key", () => ({
  getProjectHostAuthPublicKey: jest.fn(() => "public-key"),
}));

jest.mock("./sqlite/projects", () => ({
  getProject: (...args: any[]) => mockGetProject(...args),
}));

jest.mock("./sqlite/account-revocations", () => ({
  getAccountRevokedBeforeMs: (...args: any[]) =>
    mockGetAccountRevokedBeforeMs(...args),
}));

import { createProjectHostConatAuth } from "./conat-auth";

describe("project-host Conat auth", () => {
  const host_id = "00000000-1000-4000-8000-000000000099";
  const project_id = "00000000-1000-4000-8000-000000000000";
  const account_id = "00000000-1000-4000-8000-000000000001";

  beforeEach(() => {
    mockVerifyProjectHostAuthToken.mockReset();
    mockGetProject.mockReset();
    mockGetAccountRevokedBeforeMs.mockReset();
    mockGetAccountRevokedBeforeMs.mockReturnValue(undefined);
  });

  it("uses bearer auth before interpreting project_id as project-secret auth", async () => {
    mockVerifyProjectHostAuthToken.mockReturnValue({
      act: "account",
      sub: account_id,
      iat: 1000,
    });
    const { getUser } = createProjectHostConatAuth({ host_id });

    await expect(
      getUser(
        {
          handshake: {
            auth: {
              bearer: "project-host-agent-token",
              project_id,
            },
            headers: {},
          },
        } as any,
        undefined as any,
      ),
    ).resolves.toEqual({
      account_id,
      auth_iat_s: 1000,
    });

    expect(mockVerifyProjectHostAuthToken).toHaveBeenCalledWith({
      token: "project-host-agent-token",
      host_id,
      public_key: "public-key",
    });
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it("still rejects project-scoped auth when project_secret is missing", async () => {
    const { getUser } = createProjectHostConatAuth({ host_id });

    await expect(
      getUser(
        {
          handshake: {
            auth: {
              project_id,
            },
            headers: {},
          },
        } as any,
        undefined as any,
      ),
    ).rejects.toThrow("missing project_secret for project auth");

    expect(mockVerifyProjectHostAuthToken).not.toHaveBeenCalled();
  });
});
