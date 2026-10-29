const mockVerifyProjectHostAuthToken = jest.fn();
const mockGetProject = jest.fn();
const mockGetRow = jest.fn(() => ({ users: {} }));
const mockGetAccountRevokedBeforeMs = jest.fn(() => undefined);
const mockCallHub = jest.fn();
const mockGetMasterConatClient = jest.fn();
const mockConfirmProjectMemberWithOwningBay = jest.fn(
  async (): Promise<any> => ({
    member: false,
    users_revision: null,
  }),
);

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

let mockProjectUsersGeneration = 0;
jest.mock("./sqlite/projects", () => ({
  getProject: (...args: any[]) => mockGetProject(...args),
  projectUsersGeneration: () => mockProjectUsersGeneration,
}));

jest.mock("./sqlite/account-revocations", () => ({
  getAccountRevokedBeforeMs: (...args: any[]) =>
    mockGetAccountRevokedBeforeMs(...args),
}));

jest.mock("./master-status", () => ({
  getMasterConatClient: (...args: any[]) => mockGetMasterConatClient(...args),
}));

jest.mock("./acp/project-membership", () => ({
  confirmProjectMemberWithOwningBay: (...args: any[]) =>
    mockConfirmProjectMemberWithOwningBay(...args),
}));

const getProjectHostManagedEgressBlockedMessageMock = jest.fn();

jest.mock("./managed-egress-runtime", () => ({
  getProjectHostManagedEgressBlockedMessage: (...args: any[]) =>
    getProjectHostManagedEgressBlockedMessageMock(...args),
}));

// The owning bay's answer, about the collaborator list at users_revision.
function bay(member: boolean, users_revision: number | null = null) {
  return { member, users_revision };
}

import {
  __test__,
  clearProjectHostConatAuthCaches,
  createProjectHostConatAuth,
} from "./conat-auth";
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
    mockConfirmProjectMemberWithOwningBay.mockReset();
    mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(false));
    clearProjectHostConatAuthCaches();
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

  it("tells the revocation check whether a bearer is an agent's (a password change leaves agents alone)", async () => {
    mockGetAccountRevokedBeforeMs.mockImplementation(
      (_id: string, opts?: { auth_actor?: string }) =>
        opts?.auth_actor === "agent" ? undefined : 5_000_000,
    );
    const { getUser } = createProjectHostConatAuth({ host_id });
    const connect = async () =>
      await getUser(
        {
          handshake: { auth: { bearer: "token" }, headers: {} },
        } as any,
        undefined as any,
      );
    mockVerifyProjectHostAuthToken.mockReturnValue({
      act: "account",
      sub: account_id,
      iat: 1000,
    });
    await expect(connect()).rejects.toThrow("session revoked");
    mockVerifyProjectHostAuthToken.mockReturnValue({
      act: "account",
      auth_actor: "agent",
      project_id,
      sid: "agent-session-1",
      jti: "agent-credential-1",
      sub: account_id,
      iat: 1000,
    });
    await expect(connect()).resolves.toMatchObject({
      account_id,
      auth_actor: "agent",
    });
    expect(mockGetAccountRevokedBeforeMs).toHaveBeenLastCalledWith(account_id, {
      auth_actor: "agent",
    });
  });

  it("keeps a scoped key in its viewer service instead of account permissions", async () => {
    const expires = Math.floor(Date.now() / 1000) + 20;
    const binding = {
      account_id,
      key_id: "key-id-123",
      scope_revision: 2,
      project_id,
      placement_revision: 7,
      capabilities: ["file:read"],
      viewer_policy_hash: "a".repeat(64),
      subjects: [
        `fs-api-key.project-${project_id}.account-${account_id}.key-key-id-123.rev-2.hash-${"a".repeat(64)}`,
      ],
      reply_prefix: "_INBOX.api-key-00000000-0000-4000-8000-000000000003",
    };
    mockVerifyProjectHostAuthToken.mockReturnValue({
      act: "account",
      sub: account_id,
      iat: expires - 20,
      exp: expires,
      api_key: binding,
    });
    mockGetProject.mockReturnValue({
      runtime_lifecycle_revision: 7,
      users: { [account_id]: { group: "collaborator" } },
    });
    const { getUser, isAllowed } = createProjectHostConatAuth({ host_id });
    const user = await getUser(
      {
        handshake: { auth: { bearer: "scoped-key-token" }, headers: {} },
      } as any,
      undefined as any,
    );
    expect(user).toMatchObject({
      account_id,
      auth_lease_exp_s: expires,
      auth_api_key: binding,
    });
    expect(
      await isAllowed({ user, subject: binding.subjects[0], type: "pub" }),
    ).toBe(true);
    mockGetProject.mockReturnValue({
      runtime_lifecycle_revision: 7,
      users: { [account_id]: { group: "viewer" } },
    });
    expect(
      await isAllowed({ user, subject: binding.subjects[0], type: "pub" }),
    ).toBe(false);
    mockGetProject.mockReturnValue({
      runtime_lifecycle_revision: 7,
      users: { [account_id]: { group: "collaborator" } },
    });
    for (const subject of [
      `fs.project-${project_id}`,
      `project.${project_id}.run`,
      `hub.account.${account_id}.api`,
    ]) {
      expect(await isAllowed({ user, subject, type: "pub" })).toBe(false);
    }
    mockGetProject.mockReturnValue({
      runtime_lifecycle_revision: 8,
      users: { [account_id]: { group: "collaborator" } },
    });
    expect(
      await isAllowed({ user, subject: binding.subjects[0], type: "pub" }),
    ).toBe(false);
  });

  it("rejects a child token after membership is removed", async () => {
    mockVerifyProjectHostAuthToken.mockReturnValue({
      act: "account",
      sub: account_id,
      exp: Math.floor(Date.now() / 1000) + 20,
      api_key: {
        project_id,
        placement_revision: 7,
        capabilities: ["project:exec"],
      },
    });
    mockGetProject.mockReturnValue({
      runtime_lifecycle_revision: 7,
      users: {},
    });
    const { getUser } = createProjectHostConatAuth({ host_id });
    await expect(
      getUser(
        {
          handshake: { auth: { bearer: "scoped-key-token" }, headers: {} },
        } as any,
        undefined as any,
      ),
    ).rejects.toThrow("no longer valid");
  });

  it("keeps agent bearer access inside its signed project on the same host", async () => {
    const otherProjectId = "00000000-1000-4000-8000-000000000002";
    mockVerifyProjectHostAuthToken.mockReturnValue({
      act: "account",
      sub: account_id,
      iat: 1000,
      auth_actor: "agent",
      project_id,
      jti: "00000000-1000-4000-8000-0000000000a4",
    });
    mockGetRow.mockReturnValue({
      users: { [account_id]: { group: "collaborator" } },
    });
    const { getUser, isAllowed } = createProjectHostConatAuth({ host_id });
    const user = await getUser({
      handshake: { auth: { bearer: "signed-agent-token" }, headers: {} },
    } as any);

    await expect(
      isAllowed({ user, type: "pub", subject: `fs.project-${project_id}` }),
    ).resolves.toBe(true);
    for (const subject of [
      `fs.project-${otherProjectId}`,
      `project.${otherProjectId}.terminal.run`,
      `fs-viewer.project-${otherProjectId}.account-${account_id}`,
      `fs-share.project-${otherProjectId}.share-${project_id}.account-${account_id}`,
      `acp.project-${otherProjectId}.account-${account_id}.api`,
    ]) {
      await expect(isAllowed({ user, type: "pub", subject })).resolves.toBe(
        false,
      );
    }
  });

  it("keeps an agent bearer off its account's hub API, account subjects and replies", async () => {
    mockGetRow.mockReturnValue({
      users: { [account_id]: { group: "collaborator" } },
    });
    const { getUser, isAllowed } = createProjectHostConatAuth({ host_id });
    // the human account first, so its decisions are cached
    mockVerifyProjectHostAuthToken.mockReturnValue({
      act: "account",
      sub: account_id,
      iat: 1000,
      auth_actor: "account",
      jti: "00000000-1000-4000-8000-0000000000a1",
    });
    const human = await getUser({
      handshake: { auth: { bearer: "account-token" }, headers: {} },
    } as any);
    expect(human.auth_api_key_reply_prefix).toBeUndefined();
    const humanInbox = `_INBOX.account-${account_id}`;
    const accountSubjects = [
      // the embedded hub API identifies callers by this subject alone
      `hub.account.${account_id}.api`,
      `account.${account_id}.account-feed-live`,
      `services.account-${account_id}.some-service`,
      `persist.account-${account_id}.id`,
    ];
    for (const subject of accountSubjects) {
      await expect(
        isAllowed({ user: human, type: "pub", subject }),
      ).resolves.toBe(true);
    }
    for (const subject of [humanInbox, `${humanInbox}.abc.>`]) {
      await expect(
        isAllowed({ user: human, type: "sub", subject }),
      ).resolves.toBe(true);
    }

    const agentClaims = {
      act: "account",
      sub: account_id,
      iat: 1000,
      auth_actor: "agent",
      project_id,
      jti: "00000000-1000-4000-8000-0000000000a2",
      sid: "00000000-1000-4000-8000-0000000000b1",
    };
    mockVerifyProjectHostAuthToken.mockReturnValue(agentClaims);
    const agent = await getUser({
      handshake: { auth: { bearer: "signed-agent-token" }, headers: {} },
    } as any);
    const agentInbox = agent.auth_api_key_reply_prefix;
    expect(agentInbox).toMatch(/^_INBOX\.api-key-[0-9a-f-]{36}$/);
    // the same for the whole agent session, so a refreshed token keeps it
    mockVerifyProjectHostAuthToken.mockReturnValue({
      ...agentClaims,
      jti: "00000000-1000-4000-8000-0000000000a3",
    });
    const refreshed = await getUser({
      handshake: { auth: { bearer: "refreshed-agent-token" }, headers: {} },
    } as any);
    expect(refreshed.auth_api_key_reply_prefix).toBe(agentInbox);

    for (const subject of accountSubjects) {
      for (const type of ["pub", "sub"] as const) {
        await expect(isAllowed({ user: agent, type, subject })).resolves.toBe(
          false,
        );
      }
    }
    // not the human's replies, even though the human's decision is cached
    for (const subject of [humanInbox, `${humanInbox}.abc.>`, "_INBOX.>"]) {
      await expect(
        isAllowed({ user: agent, type: "sub", subject }),
      ).resolves.toBe(false);
    }
    // its own replies, and answering anyone's requests
    for (const subject of [agentInbox, `${agentInbox}.abc.>`]) {
      await expect(
        isAllowed({ user: agent, type: "sub", subject }),
      ).resolves.toBe(true);
    }
    await expect(
      isAllowed({ user: agent, type: "pub", subject: `${humanInbox}.abc.1` }),
    ).resolves.toBe(true);
    // still fine inside its own project
    await expect(
      isAllowed({
        user: agent,
        type: "pub",
        subject: `fs.project-${project_id}`,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a direct account bearer after its browser session expires", async () => {
    mockVerifyProjectHostAuthToken.mockReturnValue({
      act: "account",
      sub: account_id,
      iat: 1000,
      auth_actor: "account",
      browser_session_exp_s: Math.floor(Date.now() / 1000) - 1,
    });
    const { getUser } = createProjectHostConatAuth({ host_id });

    await expect(
      getUser(
        {
          handshake: {
            auth: { bearer: "expired-restricted-session-token" },
            headers: {},
          },
        } as any,
        undefined as any,
      ),
    ).rejects.toThrow("browser session authorization expired");
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

  it("refuses a browser-session websocket opened by another site", async () => {
    const savedSiteUrl = process.env.COCALC_SITE_URL;
    process.env.COCALC_SITE_URL = "https://cocalc.example";
    try {
      const { getUser } = createProjectHostConatAuth({ host_id });
      const cookie = `cocalc_project_host_session=${encodeURIComponent(
        createProjectHostBrowserSessionToken({
          account_id,
          now_ms: Date.now(),
        }),
      )}`;
      const connect = (origin: string) =>
        getUser(
          {
            handshake: {
              headers: { cookie, origin, host: "host-1.cocalc.example" },
            },
          } as any,
          undefined as any,
        );
      await expect(connect("https://evil.example")).rejects.toThrow(
        "cross-site connection refused",
      );
      await expect(connect("https://cocalc.example")).resolves.toMatchObject({
        account_id,
      });
    } finally {
      if (savedSiteUrl == null) delete process.env.COCALC_SITE_URL;
      else process.env.COCALC_SITE_URL = savedSiteUrl;
    }
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
      `persist.project-${project_id}.id`,
      `persist.project-${project_id}.server.shard.client`,
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
      "harness-v1",
      "interrupt",
      "steer",
      "fork",
      "truncate",
      "control",
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
          isAllowed({
            user: { account_id, auth_actor: "account" },
            type: "pub",
            subject,
          }),
        ).resolves.toBe(true);
        await expect(
          isAllowed({ user: { account_id }, type: "sub", subject }),
        ).resolves.toBe(false);
      },
    );

    it("refuses the retired automation operation, even to a collaborator's fresh human credential", async () => {
      mockVerifyProjectHostAuthToken.mockReturnValue({
        act: "account",
        sub: account_id,
        iat: 1000,
        auth_actor: "account",
      });
      mockGetRow.mockReturnValue({
        users: { [account_id]: { group: "collaborator" } },
      });
      const { getUser, isAllowed } = createProjectHostConatAuth({ host_id });
      const user = await getUser({
        handshake: { auth: { bearer: "signed-human-token" }, headers: {} },
      } as any);
      await expect(
        isAllowed({
          user,
          type: "pub",
          subject: `acp.project-${project_id}.account-${account_id}.automation`,
        }),
      ).resolves.toBe(false);
      await expect(
        isAllowed({
          user,
          type: "pub",
          subject: `acp.project-${project_id}.account-${account_id}.api`,
        }),
      ).resolves.toBe(true);
    });

    it.each(["api", "harness-v1"])(
      "rejects account and project authorization mismatches for %s",
      async (operation) => {
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
            subject: `acp.project-${project_id}.account-${otherAccountId}.${operation}`,
          }),
        ).resolves.toBe(false);
        await expect(
          isAllowed({
            user: { account_id },
            type: "pub",
            subject: `acp.project-${otherProjectId}.account-${account_id}.${operation}`,
          }),
        ).resolves.toBe(false);
      },
    );

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

  it("allows only hub principals to use the persist fence service", async () => {
    mockGetRow.mockReturnValue({
      users: { [account_id]: { group: "collaborator" } },
    });
    const { isAllowed } = createProjectHostConatAuth({ host_id });
    for (const subject of [
      "persist-control.fence",
      "persist-control",
      `persist-control.project-${project_id}`,
    ]) {
      for (const type of ["pub", "sub"] as const) {
        await expect(
          isAllowed({ user: { hub_id: "hub" }, type, subject }),
        ).resolves.toBe(true);
        await expect(
          isAllowed({ user: { account_id }, type, subject }),
        ).resolves.toBe(false);
        await expect(
          isAllowed({ user: { project_id }, type, subject }),
        ).resolves.toBe(false);
      }
    }
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
  describe("collaborator list that lags the owning bay", () => {
    const fsSubject = `fs.project-${project_id}`;
    const cursorSubject = `project.${project_id}.pubsub-cursors.L2hvbWUvdXNlci9hLnB5`;

    it("asks the bay before refusing an account a missing project row does not know", async () => {
      // An archived project has no row on the host until it starts again.
      mockGetRow.mockReturnValue(undefined);
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(true));
      const { isAllowed } = createProjectHostConatAuth({ host_id });

      for (const subject of [fsSubject, cursorSubject]) {
        await expect(
          isAllowed({ user: { account_id }, type: "pub", subject }),
        ).resolves.toBe(true);
      }
      await expect(
        isAllowed({
          user: { account_id },
          type: "sub",
          subject: cursorSubject,
        }),
      ).resolves.toBe(true);
      // A grant is never cached: each check asks again (a refusal is cached).
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(3);
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledWith(
        expect.objectContaining({ account_id, project_id }),
      );
    });

    it("asks the bay when the row exists but does not list the account", async () => {
      mockGetRow.mockReturnValue({
        users: { "00000000-1000-4000-8000-000000000009": { group: "owner" } },
      });
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(true));
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
      ).resolves.toBe(true);
    });

    it("keeps a refusal from the bay briefly, until a collaborator sync", async () => {
      mockGetRow.mockReturnValue({ users: {} });
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      for (let i = 0; i < 3; i++) {
        await expect(
          isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
        ).resolves.toBe(false);
      }
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(1);

      clearProjectHostConatAuthCaches();
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(true));
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
      ).resolves.toBe(true);
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(2);
    });

    it("does not use a bay answer after a newer collaborator list is stored", async () => {
      // The bay's list (revision 5) still has the account; it is confirmed.
      mockGetRow.mockReturnValue({
        users: { "00000000-1000-4000-8000-000000000009": { group: "owner" } },
        users_revision: 5,
      });
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(true, 5));
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
      ).resolves.toBe(true);
      // Another account's lookup stores revision 6, which removed the account
      // (without a collaborator sync clearing the caches).
      mockGetRow.mockReturnValue({
        users: { "00000000-1000-4000-8000-000000000009": { group: "owner" } },
        users_revision: 6,
      });
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(false));
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
      ).resolves.toBe(false);
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(2);
    });

    it("lets a newer list stored during a bay request decide over its positive answer", async () => {
      const other = "00000000-1000-4000-8000-000000000009";
      mockGetRow.mockReturnValue({
        users: { [other]: { group: "owner" } },
        users_revision: 5,
      });
      let resolve!: (answer: any) => void;
      mockConfirmProjectMemberWithOwningBay.mockReturnValue(
        new Promise<any>((r) => (resolve = r)),
      );
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      const decision = isAllowed({
        user: { account_id },
        type: "pub",
        subject: fsSubject,
      });
      await new Promise((r) => setImmediate(r));
      // Another lookup stores revision 6, which removed the account, before
      // this request's answer about revision 5 is used.
      mockGetRow.mockReturnValue({
        users: { [other]: { group: "owner" } },
        users_revision: 6,
      });
      resolve(bay(true, 5));
      await expect(decision).resolves.toBe(false);
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
      ).resolves.toBe(false);
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(1);
    });

    it("asks the bay once for concurrent publishes", async () => {
      mockGetRow.mockReturnValue(undefined);
      let resolve!: (answer: any) => void;
      mockConfirmProjectMemberWithOwningBay.mockReturnValue(
        new Promise<any>((r) => (resolve = r)),
      );
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      const decisions = [1, 2, 3].map(() =>
        isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
      );
      await new Promise((r) => setImmediate(r));
      resolve(bay(true));
      await expect(Promise.all(decisions)).resolves.toEqual([true, true, true]);
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(1);
    });

    it("lets a collaborator sync during a bay request decide, for waiting and joining callers", async () => {
      mockGetRow.mockReturnValue(undefined);
      const pending: Array<(answer: any) => void> = [];
      mockConfirmProjectMemberWithOwningBay.mockImplementation(
        () => new Promise<any>((r) => pending.push(r)),
      );
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      const before = isAllowed({
        user: { account_id },
        type: "pub",
        subject: fsSubject,
      });
      await new Promise((r) => setImmediate(r));
      expect(pending).toHaveLength(1);

      // The sync stores a list without the account (it was removed).
      mockGetRow.mockReturnValue({
        users: { "00000000-1000-4000-8000-000000000009": { group: "owner" } },
      });
      clearProjectHostConatAuthCaches();
      const after = isAllowed({
        user: { account_id },
        type: "pub",
        subject: fsSubject,
      });
      await new Promise((r) => setImmediate(r));
      expect(pending).toHaveLength(1);

      // The bay's yes predates the sync: the list the sync stored decides,
      // for the caller that was waiting and for the one that joined.
      pending[0](bay(true));
      await expect(before).resolves.toBe(false);
      await expect(after).resolves.toBe(false);
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
      ).resolves.toBe(false);
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(1);
    });

    it("never reuses a grant after an unversioned list without the account appears", async () => {
      // A bay without collaborator revisions (rolling upgrade) confirms the
      // account for a project with no local row.
      mockGetRow.mockReturnValue(undefined);
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(true, null));
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
      ).resolves.toBe(true);
      // The project starts and stores an unversioned list that no longer has
      // the account; nothing clears the caches.
      mockGetRow.mockReturnValue({
        users: { "00000000-1000-4000-8000-000000000009": { group: "owner" } },
      });
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(false, null));
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
      ).resolves.toBe(false);
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(2);
    });

    it("lets a list changed and changed back during a bay request decide", async () => {
      // Unversioned lists (rolling upgrade): the account is added, the bay
      // says yes, and the account is removed again, all while the request is
      // pending; the list then looks as it did before.
      const other = "00000000-1000-4000-8000-000000000009";
      mockGetRow.mockReturnValue({ users: { [other]: { group: "owner" } } });
      let resolve!: (answer: any) => void;
      mockConfirmProjectMemberWithOwningBay.mockReturnValue(
        new Promise<any>((r) => (resolve = r)),
      );
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      const decision = isAllowed({
        user: { account_id },
        type: "pub",
        subject: fsSubject,
      });
      await new Promise((r) => setImmediate(r));
      mockProjectUsersGeneration += 2;
      resolve(bay(true, null));
      await expect(decision).resolves.toBe(false);
    });

    it("does not let another project's collaborator sync overrule a bay answer", async () => {
      mockGetRow.mockReturnValue(undefined);
      let resolve!: (answer: any) => void;
      mockConfirmProjectMemberWithOwningBay.mockReturnValue(
        new Promise<any>((r) => (resolve = r)),
      );
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      const decision = isAllowed({
        user: { account_id },
        type: "pub",
        subject: fsSubject,
      });
      await new Promise((r) => setImmediate(r));
      // A sync of some other project (this project's row is unchanged).
      clearProjectHostConatAuthCaches();
      resolve(bay(true));
      await expect(decision).resolves.toBe(true);
    });

    it("bounds the bay requests one account and the host can have running", async () => {
      mockGetRow.mockReturnValue(undefined);
      const pending: Array<(answer: any) => void> = [];
      mockConfirmProjectMemberWithOwningBay.mockImplementation(
        () => new Promise<any>((r) => pending.push(r)),
      );
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      const uuid = (prefix: string, i: number) =>
        `${prefix}-1000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      const decisions: Promise<boolean>[] = [];
      // One account, many projects: only 4 requests, the rest refused at once.
      for (let i = 0; i < 10; i++) {
        decisions.push(
          isAllowed({
            user: { account_id },
            type: "pub",
            subject: `fs.project-${uuid("00000000", 100 + i)}`,
          }),
        );
      }
      await new Promise((r) => setImmediate(r));
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(4);
      await expect(Promise.all(decisions.slice(4))).resolves.toEqual(
        Array(6).fill(false),
      );
      // Many accounts: at most 32 requests on the host.
      for (let a = 0; a < 20; a++) {
        for (let i = 0; i < 4; i++) {
          decisions.push(
            isAllowed({
              user: { account_id: uuid("00000001", a) },
              type: "pub",
              subject: `fs.project-${uuid("00000002", i)}`,
            }),
          );
        }
      }
      await new Promise((r) => setImmediate(r));
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(32);
      for (const resolve of pending) resolve(bay(true));
      await Promise.all(decisions);
      // Finished requests free their places.
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(true));
      await expect(
        isAllowed({
          user: { account_id },
          type: "pub",
          subject: `fs.project-${uuid("00000000", 999)}`,
        }),
      ).resolves.toBe(true);
    });

    it("asks the bay for a runtime presence heartbeat too, but never for a wrong scope", async () => {
      // Refused heartbeats would let idle maintenance stop the project.
      mockGetRow.mockReturnValue(undefined);
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(true));
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      const subject = browserRuntimePresenceSubject({ project_id, account_id });
      const browser = {
        account_id,
        auth_scopes: [BROWSER_RUNTIME_PRESENCE_AUTH_SCOPE],
      };
      await expect(
        isAllowed({ user: browser, type: "pub", subject }),
      ).resolves.toBe(true);
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(1);
      // Without the scope, or to subscribe, the bay is not asked at all.
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject }),
      ).resolves.toBe(false);
      await expect(
        isAllowed({ user: browser, type: "sub", subject }),
      ).resolves.toBe(false);
      expect(mockConfirmProjectMemberWithOwningBay).toHaveBeenCalledTimes(1);
      // And a bay refusal is a refusal.
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(false));
      clearProjectHostConatAuthCaches();
      await expect(
        isAllowed({ user: browser, type: "pub", subject }),
      ).resolves.toBe(false);
    });

    it("does not ask the bay for an account the row knows in another role", async () => {
      mockGetRow.mockReturnValue({
        users: {
          [account_id]: {
            group: "viewer",
            read_policy: { rules: [{ action: "include", path: "." }] },
          },
        },
      });
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(true));
      const { isAllowed } = createProjectHostConatAuth({ host_id });
      await expect(
        isAllowed({ user: { account_id }, type: "pub", subject: fsSubject }),
      ).resolves.toBe(false);
      expect(mockConfirmProjectMemberWithOwningBay).not.toHaveBeenCalled();
    });

    it("does not let the bay widen an agent beyond its project", async () => {
      mockGetRow.mockReturnValue(undefined);
      mockConfirmProjectMemberWithOwningBay.mockResolvedValue(bay(true));
      mockVerifyProjectHostAuthToken.mockReturnValue({
        act: "account",
        sub: account_id,
        iat: 1000,
        auth_actor: "agent",
        project_id,
        jti: "00000000-1000-4000-8000-0000000000a5",
      });
      const { getUser, isAllowed } = createProjectHostConatAuth({ host_id });
      const agent = await getUser({
        handshake: { auth: { bearer: "signed-agent-token" }, headers: {} },
      } as any);
      await expect(
        isAllowed({
          user: agent,
          type: "pub",
          subject: "fs.project-00000000-1000-4000-8000-000000000002",
        }),
      ).resolves.toBe(false);
      expect(mockConfirmProjectMemberWithOwningBay).not.toHaveBeenCalled();
    });
  });
});
