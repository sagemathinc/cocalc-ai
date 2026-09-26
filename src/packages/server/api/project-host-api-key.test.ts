export {};

const accountId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const hostId = "00000000-0000-4000-8000-000000000003";
const otherHostId = "00000000-0000-4000-8000-000000000004";
const getApiKeyAuthorizationStateMock = jest.fn();
const resolveProjectReferenceMock = jest.fn();
const syncProjectUsersMock = jest.fn();
const resolveHostBayMock = jest.fn();
const issueTokenMock = jest.fn();
const remoteIssueMock = jest.fn();

jest.mock("@cocalc/server/api/key-authorization-state", () => ({
  getApiKeyAuthorizationState: (...args: any[]) =>
    getApiKeyAuthorizationStateMock(...args),
}));
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  resolveProjectReferenceForMemberAllowRemote: (...args: any[]) =>
    resolveProjectReferenceMock(...args),
}));
jest.mock("@cocalc/server/conat/api/hosts-connection-auth", () => ({
  syncProjectUsersOnHostForBrowserAccess: (...args: any[]) =>
    syncProjectUsersMock(...args),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveHostBay: (...args: any[]) => resolveHostBayMock(...args),
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: jest.fn(() => ({
    projectHostAuthToken: () => ({
      issueApiKey: (...args: any[]) => remoteIssueMock(...args),
    }),
  })),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));
jest.mock("@cocalc/backend/data", () => ({
  getProjectHostAuthTokenPrivateKey: jest.fn(() => "private-key"),
}));
jest.mock("@cocalc/conat/auth/project-host-token", () => ({
  issueProjectHostApiKeyAuthToken: (...args: any[]) => issueTokenMock(...args),
}));

describe("scoped API key project-host issuance", () => {
  const request = {
    account_id: accountId,
    key_id: "key-id-123",
    scope_revision: 4,
    project_id: projectId,
    host_id: hostId,
  };
  const state = (capabilities: string[], viewer_read_roots?: string[]) => ({
    scope_revision: 4,
    issuance_sequence: "1",
    expire_ms: Date.now() + 60_000,
    scope: {
      version: 1,
      account: [],
      projects: [
        {
          project_id: projectId,
          capabilities,
          ...(viewer_read_roots ? { viewer_read_roots } : {}),
        },
      ],
    },
  });

  beforeEach(() => {
    getApiKeyAuthorizationStateMock.mockReset();
    resolveProjectReferenceMock.mockReset();
    syncProjectUsersMock.mockReset();
    resolveHostBayMock.mockReset();
    issueTokenMock.mockReset();
    remoteIssueMock.mockReset();
    resolveHostBayMock.mockResolvedValue({ bay_id: "bay-0" });
    getApiKeyAuthorizationStateMock.mockResolvedValue(
      state(["project:exec", "file:read", "file:write"]),
    );
    resolveProjectReferenceMock.mockResolvedValue({
      host_id: hostId,
      runtime_lifecycle_revision: 7,
      api_key_membership_revocation: null,
      users: { [accountId]: { group: "collaborator" } },
    });
    syncProjectUsersMock.mockResolvedValue(undefined);
    issueTokenMock.mockReturnValue({ token: "child", expires_at: 12345 });
  });

  it("derives full runtime claims from current home scope and placement", async () => {
    const { issueProjectHostApiKeyTokenLocal } =
      await import("./project-host-api-key");
    await expect(issueProjectHostApiKeyTokenLocal(request)).resolves.toEqual({
      host_id: hostId,
      token: "child",
      expires_at: 12345,
    });
    expect(getApiKeyAuthorizationStateMock).toHaveBeenCalledWith({
      account_id: accountId,
      key_id: "key-id-123",
    });
    expect(issueTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: accountId,
        project_id: projectId,
        host_id: hostId,
        scope_revision: 4,
        placement_revision: 7,
        capabilities: ["project:exec", "file:read", "file:write"],
        private_key: "private-key",
      }),
    );
    expect(issueTokenMock.mock.calls[0][0].viewer_policy_hash).toBeUndefined();
  });

  it("accepts the initial project-host placement revision", async () => {
    resolveProjectReferenceMock.mockResolvedValue({
      host_id: hostId,
      runtime_lifecycle_revision: 0,
      api_key_membership_revocation: null,
      users: { [accountId]: { group: "collaborator" } },
    });
    const { issueProjectHostApiKeyTokenLocal } =
      await import("./project-host-api-key");
    await expect(issueProjectHostApiKeyTokenLocal(request)).resolves.toEqual({
      host_id: hostId,
      token: "child",
      expires_at: 12345,
    });
    expect(issueTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ placement_revision: 0 }),
    );
  });

  it("confines all-projects access to current full membership and exact child targets", async () => {
    getApiKeyAuthorizationStateMock.mockResolvedValue({
      scope_revision: 4,
      issuance_sequence: "1",
      scope: {
        version: 1,
        account: [],
        projects: [],
        all_projects: { capabilities: ["file:read"], viewer_read_roots: ["."] },
      },
    });
    const { issueProjectHostApiKeyTokenLocal } =
      await import("./project-host-api-key");
    await issueProjectHostApiKeyTokenLocal(request);
    expect(issueTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: projectId,
        host_id: hostId,
        capabilities: ["file:read"],
        viewer_policy_hash: expect.any(String),
      }),
    );
    issueTokenMock.mockClear();
    for (const users of [{}, { [accountId]: { group: "viewer" } }]) {
      resolveProjectReferenceMock.mockResolvedValue({
        host_id: hostId,
        runtime_lifecycle_revision: 7,
        users,
      });
      await expect(issueProjectHostApiKeyTokenLocal(request)).rejects.toThrow(
        "not authorized",
      );
    }
    expect(issueTokenMock).not.toHaveBeenCalled();
  });

  it("binds a viewer key to its actual read policy", async () => {
    getApiKeyAuthorizationStateMock.mockResolvedValue(
      state(["file:read"], ["data"]),
    );
    const { issueProjectHostApiKeyTokenLocal } =
      await import("./project-host-api-key");
    await issueProjectHostApiKeyTokenLocal(request);
    expect(issueTokenMock.mock.calls[0][0].viewer_policy_hash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("requires a full collaborator even for a read-only key", async () => {
    getApiKeyAuthorizationStateMock.mockResolvedValue(
      state(["file:read"], ["data"]),
    );
    resolveProjectReferenceMock.mockResolvedValue({
      host_id: hostId,
      runtime_lifecycle_revision: 7,
      users: { [accountId]: { group: "viewer" } },
    });
    const { issueProjectHostApiKeyTokenLocal } =
      await import("./project-host-api-key");
    await expect(issueProjectHostApiKeyTokenLocal(request)).rejects.toThrow(
      "not authorized",
    );
    expect(issueTokenMock).not.toHaveBeenCalled();
  });

  it("denies revoked revisions, host substitutions, and viewer writes", async () => {
    const { issueProjectHostApiKeyTokenLocal } =
      await import("./project-host-api-key");
    getApiKeyAuthorizationStateMock.mockResolvedValueOnce(null);
    await expect(issueProjectHostApiKeyTokenLocal(request)).rejects.toThrow(
      "revoked",
    );
    await expect(
      issueProjectHostApiKeyTokenLocal({
        ...request,
        scope_revision: 3,
      }),
    ).rejects.toThrow("scope changed");
    resolveProjectReferenceMock.mockResolvedValueOnce({
      host_id: otherHostId,
      runtime_lifecycle_revision: 7,
      users: { [accountId]: { group: "collaborator" } },
    });
    await expect(issueProjectHostApiKeyTokenLocal(request)).rejects.toThrow(
      "not authorized",
    );
    resolveProjectReferenceMock.mockResolvedValueOnce({
      host_id: hostId,
      runtime_lifecycle_revision: 7,
      users: { [accountId]: { group: "viewer" } },
    });
    await expect(issueProjectHostApiKeyTokenLocal(request)).rejects.toThrow(
      "not authorized",
    );
    expect(issueTokenMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "blocks old delegated access after re-addition (all projects: %s)",
    async (allProjects) => {
      const key = state(["project:exec"]);
      if (allProjects)
        (key as any).scope = {
          version: 1,
          account: [],
          projects: [],
          all_projects: { capabilities: ["project:exec"] },
        };
      getApiKeyAuthorizationStateMock.mockResolvedValue(key);
      const reference = {
        host_id: hostId,
        runtime_lifecycle_revision: 7,
        users: { [accountId]: { group: "collaborator" } },
        api_key_membership_revocation: {
          generation: "11111111-1111-4111-8111-111111111111",
          pending: true,
          cutoff: "1",
        },
      };
      resolveProjectReferenceMock.mockResolvedValue(reference);
      const { issueProjectHostApiKeyTokenLocal } =
        await import("./project-host-api-key");
      await expect(issueProjectHostApiKeyTokenLocal(request)).rejects.toThrow(
        "pending",
      );
      reference.api_key_membership_revocation.pending = false;
      await expect(issueProjectHostApiKeyTokenLocal(request)).rejects.toThrow(
        "membership loss",
      );
      expect(issueTokenMock).not.toHaveBeenCalled();
      getApiKeyAuthorizationStateMock.mockResolvedValue({
        ...key,
        issuance_sequence: "2",
      });
      await expect(
        issueProjectHostApiKeyTokenLocal(request),
      ).resolves.toMatchObject({ token: "child" });
    },
  );

  it("routes signing to the owning host bay", async () => {
    resolveHostBayMock.mockResolvedValue({ bay_id: "bay-2" });
    remoteIssueMock.mockResolvedValue({
      host_id: hostId,
      token: "remote-child",
      expires_at: 12345,
    });
    const { issueProjectHostApiKeyToken } =
      await import("./project-host-api-key");
    await expect(issueProjectHostApiKeyToken(request)).resolves.toMatchObject({
      token: "remote-child",
    });
    expect(remoteIssueMock).toHaveBeenCalledWith(request);
    expect(issueTokenMock).not.toHaveBeenCalled();
  });
});
