const mockVerifyProjectHostAuthToken = jest.fn();
const mockGetProject = jest.fn();
const mockGetRow = jest.fn(() => ({ users: {} }));
const mockGetAccountRevokedBeforeMs = jest.fn(() => undefined);
const mockCallHub = jest.fn();
const mockGetMasterConatClient = jest.fn();

jest.mock("@cocalc/conat/auth/project-host-token", () => ({
  verifyProjectHostAuthToken: (...args: any[]) =>
    mockVerifyProjectHostAuthToken(...args),
}));

jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: (...args: any[]) => mockGetRow(...args),
}));

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCallHub(...args),
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

jest.mock("./master-status", () => ({
  getMasterConatClient: (...args: any[]) => mockGetMasterConatClient(...args),
}));

const getProjectHostManagedEgressBlockedMessageMock = jest.fn();

jest.mock("./managed-egress-runtime", () => ({
  getProjectHostManagedEgressBlockedMessage: (...args: any[]) =>
    getProjectHostManagedEgressBlockedMessageMock(...args),
}));

import { __test__, createProjectHostConatAuth } from "./conat-auth";
import { createProjectHostBrowserSessionToken } from "./browser-session";
import {
  BROWSER_RUNTIME_PRESENCE_AUTH_SCOPE,
  browserRuntimePresenceSubject,
} from "@cocalc/conat/project-host/browser-runtime-presence";

describe("project-host Conat auth", () => {
  const host_id = "00000000-1000-4000-8000-000000000099";
  const project_id = "00000000-1000-4000-8000-000000000000";
  const account_id = "00000000-1000-4000-8000-000000000001";

  beforeEach(() => {
    mockVerifyProjectHostAuthToken.mockReset();
    mockGetProject.mockReset();
    mockGetRow.mockReset();
    mockGetRow.mockReturnValue({ users: {} });
    mockGetAccountRevokedBeforeMs.mockReset();
    mockGetAccountRevokedBeforeMs.mockReturnValue(undefined);
    mockCallHub.mockReset();
    mockGetMasterConatClient.mockReset();
    mockGetMasterConatClient.mockReturnValue(undefined);
    getProjectHostManagedEgressBlockedMessageMock.mockReset();
    getProjectHostManagedEgressBlockedMessageMock.mockReturnValue(undefined);
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

  it("blocks browser-session auth when interactive managed egress is disabled for the account", async () => {
    getProjectHostManagedEgressBlockedMessageMock.mockReturnValue(
      "interactive blocked",
    );
    const { getUser } = createProjectHostConatAuth({ host_id });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });

    await expect(
      getUser(
        {
          handshake: {
            headers: {
              cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
            },
          },
        } as any,
        undefined as any,
      ),
    ).rejects.toMatchObject({
      message: "interactive blocked",
      code: 429,
      authFailure: false,
    });
  });

  it("prefers browser-session account auth over project-secret cookies when both are present", async () => {
    mockGetProject.mockReturnValue({
      project_id,
      secret_token: "project-secret",
    });
    const { getUser } = createProjectHostConatAuth({ host_id });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });

    await expect(
      getUser(
        {
          handshake: {
            headers: {
              cookie: [
                `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
                `project_id=${encodeURIComponent(project_id)}`,
                "project_secret=project-secret",
              ].join("; "),
            },
          },
        } as any,
        undefined as any,
      ),
    ).resolves.toMatchObject({
      account_id,
      auth_iat_s: expect.any(Number),
    });
  });

  it("accepts a valid duplicate browser-session cookie after a stale duplicate", async () => {
    const { getUser } = createProjectHostConatAuth({ host_id });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });

    await expect(
      getUser(
        {
          handshake: {
            headers: {
              cookie: [
                "cocalc_project_host_session=stale-browser-session",
                `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
              ].join("; "),
            },
          },
        } as any,
        undefined as any,
      ),
    ).resolves.toMatchObject({
      account_id,
      auth_iat_s: expect.any(Number),
      auth_scopes: [BROWSER_RUNTIME_PRESENCE_AUTH_SCOPE],
    });
  });

  it("reserves runtime presence for collaborator browser sessions", async () => {
    mockGetRow.mockReturnValue({
      users: { [account_id]: { group: "collaborator" } },
    });
    const { isAllowed } = createProjectHostConatAuth({ host_id });
    const subject = browserRuntimePresenceSubject({ project_id, account_id });

    await expect(
      isAllowed({
        user: {
          account_id,
          auth_scopes: [BROWSER_RUNTIME_PRESENCE_AUTH_SCOPE],
        },
        type: "pub",
        subject,
      }),
    ).resolves.toBe(true);
    await expect(
      isAllowed({ user: { account_id }, type: "pub", subject }),
    ).resolves.toBe(false);
    await expect(
      isAllowed({
        user: {
          account_id,
          auth_scopes: [BROWSER_RUNTIME_PRESENCE_AUTH_SCOPE],
        },
        type: "sub",
        subject,
      }),
    ).resolves.toBe(false);
  });

  it("only allows project-scoped auth from trusted local addresses", async () => {
    mockGetProject.mockReturnValue({
      project_id,
      secret_token: "project-secret",
    });
    const { getUser } = createProjectHostConatAuth({ host_id });

    await expect(
      getUser(
        {
          handshake: {
            address: "198.51.100.10",
            auth: {
              project_id,
              project_secret: "project-secret",
            },
            headers: {},
          },
        } as any,
        undefined as any,
      ),
    ).rejects.toThrow(
      "project-scoped auth is only allowed from trusted local addresses",
    );
  });

  it("rejects forwarded external project-scoped auth even when the immediate peer is loopback", () => {
    expect(
      __test__.isTrustedLocalProjectScopedPeer({
        handshake: {
          address: "::ffff:127.0.0.1",
          headers: {
            "x-forwarded-for": "203.0.113.44",
          },
        },
      } as any),
    ).toBe(false);
  });

  it("allows viewers only on their viewer fs subject", async () => {
    mockGetRow.mockReturnValue({
      users: {
        [account_id]: {
          group: "viewer",
          read_policy: { rules: [{ action: "include", path: "public/**" }] },
        },
      },
    });
    const { isAllowed } = createProjectHostConatAuth({ host_id });

    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs-viewer.project-${project_id}.account-${account_id}`,
      }),
    ).resolves.toBe(true);
    await expect(
      isAllowed({
        user: { account_id },
        type: "sub",
        subject: `fs-viewer.project-${project_id}.account-${account_id}`,
      }),
    ).resolves.toBe(false);
    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs.project-${project_id}`,
      }),
    ).resolves.toBe(false);
    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs-viewer.project-${project_id}.account-00000000-1000-4000-8000-000000000002`,
      }),
    ).resolves.toBe(false);
  });

  it("allows temporary public-share viewers on their viewer fs subject", async () => {
    mockGetRow.mockReturnValue({ users: {} });
    mockGetMasterConatClient.mockReturnValue({ id: "master" });
    mockCallHub.mockResolvedValue({
      project_id,
      account_id,
      read_policy: { rules: [{ action: "include", path: "share/**" }] },
    });
    const { isAllowed } = createProjectHostConatAuth({ host_id });

    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs-viewer.project-${project_id}.account-${account_id}`,
      }),
    ).resolves.toBe(true);
    expect(mockCallHub).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id,
        name: "publicDirectoryShares.getTemporaryViewerReadPolicy",
        args: [{ account_id, project_id }],
      }),
    );
    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs.project-${project_id}`,
      }),
    ).resolves.toBe(false);
  });

  it("does not reuse stale collaborator authorization after an account becomes a viewer", async () => {
    let projectRead = 0;
    mockGetRow.mockImplementation((table) => {
      if (table === "accounts") return undefined;
      projectRead += 1;
      return projectRead === 1
        ? {
            users: {
              [account_id]: "collaborator",
            },
          }
        : {
            users: {
              [account_id]: {
                group: "viewer",
                read_policy: {
                  rules: [{ action: "include", path: "public/**" }],
                },
              },
            },
          };
    });
    const { isAllowed } = createProjectHostConatAuth({ host_id });

    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs.project-${project_id}`,
      }),
    ).resolves.toBe(true);
    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs.project-${project_id}`,
      }),
    ).resolves.toBe(false);
    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs-viewer.project-${project_id}.account-${account_id}`,
      }),
    ).resolves.toBe(true);
  });

  it("denies viewer access to normal project-host data-plane subjects", async () => {
    mockGetRow.mockReturnValue({
      users: {
        [account_id]: {
          group: "viewer",
          read_policy: { rules: [{ action: "include", path: "." }] },
        },
      },
    });
    const { isAllowed } = createProjectHostConatAuth({ host_id });

    const blockedSubjects = [
      `fs.project-${project_id}`,
      `file-server.${project_id}.api`,
      `project.${project_id}.run`,
      `project.${project_id}.terminal.-`,
      `project.${project_id}.storage-info.-`,
      `project.${project_id}.archive-info.-`,
      `project.${project_id}.touch.-`,
      `persist.project-${project_id}`,
      `acp.project-${project_id}`,
      `codex.project-${project_id}.device-auth`,
      `hub.project.${project_id}.api`,
    ];

    for (const subject of blockedSubjects) {
      await expect(
        isAllowed({
          user: { account_id },
          type: "pub",
          subject,
        }),
      ).resolves.toBe(false);
      await expect(
        isAllowed({
          user: { account_id },
          type: "sub",
          subject,
        }),
      ).resolves.toBe(false);
    }
  });

  describe("ACP account and project binding", () => {
    const otherAccountId = "00000000-1000-4000-8000-000000000002";
    const otherProjectId = "00000000-1000-4000-8000-000000000003";
    const operations = [
      "api",
      "interrupt",
      "steer",
      "fork",
      "truncate",
      "control",
      "automation",
      "attention",
    ];

    it.each(operations)(
      "allows a matching local collaborator to publish %s",
      async (operation) => {
        mockGetRow.mockReturnValue({
          users: { [account_id]: { group: "collaborator" } },
        });
        const { isAllowed } = createProjectHostConatAuth({ host_id });
        const subject = `acp.project-${project_id}.account-${account_id}.${operation}`;

        await expect(
          isAllowed({ user: { account_id }, type: "pub", subject }),
        ).resolves.toBe(true);
        await expect(
          isAllowed({ user: { account_id }, type: "sub", subject }),
        ).resolves.toBe(false);
      },
    );

    it("rejects account and project authorization mismatches", async () => {
      mockGetRow.mockImplementation((_table, key) => {
        const requestedProjectId = JSON.parse(key).project_id;
        return requestedProjectId === project_id
          ? { users: { [account_id]: { group: "collaborator" } } }
          : { users: {} };
      });
      const { isAllowed } = createProjectHostConatAuth({ host_id });

      await expect(
        isAllowed({
          user: { account_id },
          type: "pub",
          subject: `acp.project-${project_id}.account-${otherAccountId}.api`,
        }),
      ).resolves.toBe(false);
      await expect(
        isAllowed({
          user: { account_id },
          type: "pub",
          subject: `acp.project-${otherProjectId}.account-${account_id}.api`,
        }),
      ).resolves.toBe(false);
    });

    it("rechecks collaboration for every attention request", async () => {
      let projectReads = 0;
      mockGetRow.mockImplementation((table) => {
        if (table !== "projects") return undefined;
        projectReads += 1;
        return projectReads === 1
          ? { users: { [account_id]: { group: "collaborator" } } }
          : { users: {} };
      });
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      const subject = `acp.project-${project_id}.account-${account_id}.attention`;

      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject }),
      ).resolves.toBe(true);
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject }),
      ).resolves.toBe(false);
    });

    it("denies project identities, viewers, and public-share-only accounts", async () => {
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      const subject = `acp.project-${project_id}.account-${account_id}.api`;

      mockGetRow.mockReturnValue({
        users: { [account_id]: { group: "viewer" } },
      });
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject }),
      ).resolves.toBe(false);
      await expect(
        isAllowed({ user: { project_id }, type: "pub", subject }),
      ).resolves.toBe(false);

      mockGetRow.mockReturnValue({ users: {} });
      await expect(
        isAllowed({
          user: { account_id: project_id },
          type: "pub",
          subject: `acp.project-${project_id}.account-${project_id}.api`,
        }),
      ).resolves.toBe(false);

      mockGetMasterConatClient.mockReturnValue({ id: "master" });
      mockCallHub.mockResolvedValue({
        project_id,
        account_id,
        read_policy: { rules: [{ action: "include", path: "share/**" }] },
      });
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject }),
      ).resolves.toBe(false);
      expect(mockCallHub).not.toHaveBeenCalled();
    });

    it("permits only collaborator publications to the legacy rejection listener", async () => {
      mockGetRow.mockReturnValue({
        users: { [account_id]: { group: "collaborator" } },
      });
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      const subject = `acp.project-${project_id}.api`;

      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject }),
      ).resolves.toBe(true);
      await expect(
        isAllowed({ user: { account_id }, type: "sub", subject }),
      ).resolves.toBe(false);
      await expect(
        isAllowed({ user: { project_id }, type: "pub", subject }),
      ).resolves.toBe(false);
    });

    it("fails closed for malformed ACP subjects", async () => {
      mockGetRow.mockReturnValue({
        users: { [account_id]: { group: "collaborator" } },
      });
      const { isAllowed } = createProjectHostConatAuth({ host_id });

      await expect(
        isAllowed({
          user: { account_id },
          type: "pub",
          subject: `acp.project-${project_id}.account-${account_id}.unknown`,
        }),
      ).resolves.toBe(false);
    });

    it("denies ACP and unrelated project subjects to exam accounts", async () => {
      mockGetRow.mockImplementation((table, key) => {
        if (table === "accounts") {
          return {
            exam_mode: true,
            exam_project_id: project_id,
          };
        }
        const requestedProjectId = JSON.parse(key).project_id;
        return requestedProjectId === project_id
          ? { users: { [account_id]: { group: "owner" } } }
          : { users: { [account_id]: { group: "owner" } } };
      });
      const { isAllowed } = createProjectHostConatAuth({ host_id });

      await expect(
        isAllowed({
          user: { account_id },
          type: "pub",
          subject: `acp.project-${project_id}.account-${account_id}.api`,
        }),
      ).resolves.toBe(false);
      await expect(
        isAllowed({
          user: { account_id },
          type: "pub",
          subject: `fs.project-${project_id}`,
        }),
      ).resolves.toBe(true);
      await expect(
        isAllowed({
          user: { account_id },
          type: "pub",
          subject: "fs.project-00000000-1000-4000-8000-000000000003",
        }),
      ).resolves.toBe(false);
    });
  });

  it("allows only hub principals to use file-server management subjects", async () => {
    mockGetRow.mockReturnValue({
      users: { [account_id]: { group: "collaborator" } },
    });
    const { isAllowed } = createProjectHostConatAuth({ host_id });
    const subject = `file-server.${project_id}`;

    await expect(
      isAllowed({ user: { hub_id: "hub" }, type: "pub", subject }),
    ).resolves.toBe(true);
    await expect(
      isAllowed({ user: { account_id }, type: "pub", subject }),
    ).resolves.toBe(false);
    await expect(
      isAllowed({ user: { project_id }, type: "pub", subject }),
    ).resolves.toBe(false);
    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs.project-${project_id}`,
      }),
    ).resolves.toBe(true);
  });

  it("does not cache negative collaborator decisions across user syncs", async () => {
    let projectRead = 0;
    mockGetRow.mockImplementation((table) => {
      if (table === "accounts") return undefined;
      projectRead += 1;
      return projectRead === 1
        ? { users: {} }
        : {
            users: {
              [account_id]: {
                group: "owner",
              },
            },
          };
    });
    const { isAllowed } = createProjectHostConatAuth({ host_id });

    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs.project-${project_id}`,
      }),
    ).resolves.toBe(false);
    await expect(
      isAllowed({
        user: { account_id },
        type: "pub",
        subject: `fs.project-${project_id}`,
      }),
    ).resolves.toBe(true);
  });
});
