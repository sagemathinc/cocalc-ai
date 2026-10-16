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
