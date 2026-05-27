import { createHash } from "node:crypto";
import { encryptSecretSettingValue } from "@cocalc/util/secret-settings-crypto";

let assertLocalProjectCollaboratorMock: jest.Mock;
let getLocalProjectAccessStatusMock: jest.Mock;
let assertProjectCollaboratorAccessAllowRemoteMock: jest.Mock;
let queryMock: jest.Mock;
let callback2Mock: jest.Mock;
let isAdminMock: jest.Mock;
let dbMock: jest.Mock;
let ensureAccountSecurityStateReadyMock: jest.Mock;
let isAccountBannedCachedMock: jest.Mock;
let listProjectedMyCollaboratorsForAccountMock: jest.Mock;
let getClusterAccountByIdMock: jest.Mock;
let getClusterAccountsByIdsMock: jest.Mock;
let syncProjectedInboundCollabInviteMock: jest.Mock;
let listProjectedInboundCollabInvitesMock: jest.Mock;
let respondProjectedInboundCollabInviteMock: jest.Mock;
let deleteProjectedInboundCollabInviteMock: jest.Mock;
let assertAccountTrustedForProductAccessMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
  getLocalProjectAccessStatus: (...args: any[]) =>
    getLocalProjectAccessStatusMock(...args),
}));

jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  __esModule: true,
  assertProjectCollaboratorAccessAllowRemote: (...args: any[]) =>
    assertProjectCollaboratorAccessAllowRemoteMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: jest.fn(async () => "https://example.com"),
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  __esModule: true,
  getBayPublicOrigin: jest.fn(async () => "https://example.com"),
}));

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  __esModule: true,
  getSecretSettingsKey: jest.fn(async () => Buffer.alloc(32, 1)),
}));

jest.mock("@cocalc/database/postgres/account-collaborator-index", () => ({
  __esModule: true,
  listProjectedMyCollaboratorsForAccount: (...args: any[]) =>
    listProjectedMyCollaboratorsForAccountMock(...args),
}));

jest.mock("@cocalc/util/async-utils", () => ({
  __esModule: true,
  callback2: (...args: any[]) => callback2Mock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/accounts/security-state", () => ({
  __esModule: true,
  ensureAccountSecurityStateReady: (...args: any[]) =>
    ensureAccountSecurityStateReadyMock(...args),
  isAccountBannedCached: (...args: any[]) => isAccountBannedCachedMock(...args),
}));

jest.mock("@cocalc/database", () => ({
  __esModule: true,
  db: (...args: any[]) => dbMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  __esModule: true,
  getClusterAccountById: (...args: any[]) => getClusterAccountByIdMock(...args),
  getClusterAccountsByIds: (...args: any[]) =>
    getClusterAccountsByIdsMock(...args),
}));

jest.mock("@cocalc/server/projects/collab-invite-inbox", () => ({
  __esModule: true,
  syncProjectedInboundCollabInvite: (...args: any[]) =>
    syncProjectedInboundCollabInviteMock(...args),
  listProjectedInboundCollabInvites: (...args: any[]) =>
    listProjectedInboundCollabInvitesMock(...args),
  respondProjectedInboundCollabInvite: (...args: any[]) =>
    respondProjectedInboundCollabInviteMock(...args),
  deleteProjectedInboundCollabInvite: (...args: any[]) =>
    deleteProjectedInboundCollabInviteMock(...args),
}));

jest.mock("@cocalc/server/accounts/trusted-product-access", () => ({
  __esModule: true,
  assertAccountTrustedForProductAccess: (...args: any[]) =>
    assertAccountTrustedForProductAccessMock(...args),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => {
  const factory = jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }));
  return {
    __esModule: true,
    default: factory,
    getLogger: factory,
  };
});

jest.mock("./collab", () => ({
  __esModule: true,
  add_collaborators_to_projects: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/hub/email", () => ({
  __esModule: true,
  send_invite_email: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/accounts/get-email-address", () => ({
  __esModule: true,
  default: jest.fn(async () => null),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  syncProjectUsersOnHost: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  __esModule: true,
  publishProjectAccountFeedEventsBestEffort: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  __esModule: true,
  appendProjectOutboxEventForProject: jest.fn(async () => undefined),
}));

describe("project collaborators local bay access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
  const TARGET_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
  const removeCollaboratorFromProject = jest.fn(async () => undefined);
  const addUserToProject = jest.fn(async () => undefined);
  const whenSentProjectInvite = jest.fn(async () => 0);
  const getServerSettingsCached = jest.fn(async () => ({
    organization_email: "help@example.com",
  }));

  function inviteTokenHash(token: string): string {
    const aad = "project_collab_invites.email-token:v2";
    const digest = createHash("sha256")
      .update(aad)
      .update("\0")
      .update(token)
      .digest("base64url");
    return `${aad}:${digest}`;
  }

  function encryptedInviteEmail(email: string): string {
    return encryptSecretSettingValue(
      "project_collab_invites.email",
      email,
      Buffer.alloc(32, 1),
    );
  }

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    getLocalProjectAccessStatusMock = jest.fn(async () => "local-project-user");
    assertProjectCollaboratorAccessAllowRemoteMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      title: "Test Project",
      host_id: null,
      owning_bay_id: "bay-0",
      users: {
        [ACCOUNT_ID]: { group: "owner" },
        [TARGET_ACCOUNT_ID]: { group: "collaborator" },
      },
    }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("AS actor_group")) {
        return {
          rows: [{ actor_group: "owner", manage_users_owner_only: false }],
        };
      }
      return { rows: [] };
    });
    callback2Mock = jest.fn(async (fn, opts) => await fn(opts));
    isAdminMock = jest.fn(async () => false);
    ensureAccountSecurityStateReadyMock = jest.fn(async () => undefined);
    isAccountBannedCachedMock = jest.fn(() => false);
    listProjectedMyCollaboratorsForAccountMock = jest.fn(async () => []);
    getClusterAccountByIdMock = jest.fn(async (account_id: string) => ({
      account_id,
      home_bay_id: "bay-0",
    }));
    getClusterAccountsByIdsMock = jest.fn(async (account_ids: string[]) =>
      account_ids.map((account_id) => ({
        account_id,
        home_bay_id: "bay-0",
      })),
    );
    syncProjectedInboundCollabInviteMock = jest.fn(async () => undefined);
    listProjectedInboundCollabInvitesMock = jest.fn(async () => []);
    respondProjectedInboundCollabInviteMock = jest.fn(async () => undefined);
    deleteProjectedInboundCollabInviteMock = jest.fn(async () => undefined);
    assertAccountTrustedForProductAccessMock = jest.fn(async () => undefined);
    resolveMembershipForAccountMock = jest.fn(async () => ({
      class: "free",
      source: "free",
      entitlements: {},
    }));
    removeCollaboratorFromProject.mockClear();
    addUserToProject.mockClear();
    whenSentProjectInvite.mockClear();
    getServerSettingsCached.mockClear();
    dbMock = jest.fn(() => ({
      remove_collaborator_from_project: removeCollaboratorFromProject,
      add_user_to_project: addUserToProject,
      when_sent_project_invite: whenSentProjectInvite,
      sent_project_invite: jest.fn(async () => undefined),
      get_server_settings_cached: getServerSettingsCached,
      account_exists: jest.fn(async ({ email_address }) =>
        email_address === "user@example.com" ? TARGET_ACCOUNT_ID : null,
      ),
    }));
    delete process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS;
  });

  it("rejects removing collaborators for wrong-bay projects", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const { removeCollaborator } = await import("./collaborators");
    await expect(
      removeCollaborator({
        account_id: ACCOUNT_ID,
        opts: {
          account_id: TARGET_ACCOUNT_ID,
          project_id: PROJECT_ID,
        },
      }),
    ).rejects.toThrow("project belongs to another bay");
    expect(callback2Mock).not.toHaveBeenCalled();
  });

  it("cancels pending invites created by a removed collaborator", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("AS actor_group")) {
        return {
          rows: [
            {
              actor_group: "owner",
              manage_users_owner_only: true,
            },
          ],
        };
      }
      if (
        sql.includes("UPDATE project_collab_invites") &&
        sql.includes("inviter_account_id=$2")
      ) {
        return {
          rows: [
            {
              invite_id: "77777777-7777-4777-8777-777777777777",
              invitee_account_id: ACCOUNT_ID,
            },
            {
              invite_id: "88888888-8888-4888-8888-888888888888",
              invitee_account_id: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { removeCollaborator } = await import("./collaborators");
    await expect(
      removeCollaborator({
        account_id: ACCOUNT_ID,
        opts: {
          account_id: TARGET_ACCOUNT_ID,
          project_id: PROJECT_ID,
        },
      }),
    ).resolves.toBeUndefined();

    expect(removeCollaboratorFromProject).toHaveBeenCalledWith({
      account_id: TARGET_ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET status='canceled'"),
      [PROJECT_ID, TARGET_ACCOUNT_ID],
    );
    expect(deleteProjectedInboundCollabInviteMock).toHaveBeenCalledWith({
      invite_id: "77777777-7777-4777-8777-777777777777",
      invitee_account_id: ACCOUNT_ID,
    });
    expect(deleteProjectedInboundCollabInviteMock).toHaveBeenCalledWith({
      invite_id: "88888888-8888-4888-8888-888888888888",
      invitee_account_id: null,
    });
  });

  it("rejects removing other collaborators when owner-only management is enabled", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("AS actor_group")) {
        return {
          rows: [
            {
              actor_group: "collaborator",
              manage_users_owner_only: true,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { removeCollaborator } = await import("./collaborators");
    await expect(
      removeCollaborator({
        account_id: ACCOUNT_ID,
        opts: {
          account_id: TARGET_ACCOUNT_ID,
          project_id: PROJECT_ID,
        },
      }),
    ).rejects.toThrow("only project owners can remove collaborators");
    expect(removeCollaboratorFromProject).not.toHaveBeenCalled();
  });

  it("allows collaborators to remove themselves when owner-only management is enabled", async () => {
    const { removeCollaborator } = await import("./collaborators");
    await expect(
      removeCollaborator({
        account_id: ACCOUNT_ID,
        opts: {
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
        },
      }),
    ).resolves.toBeUndefined();

    expect(removeCollaboratorFromProject).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("AS actor_group"),
      expect.anything(),
    );
  });

  it("rejects account invites from collaborators when owner-only management is enabled", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("AS actor_group")) {
        return {
          rows: [
            {
              actor_group: "collaborator",
              manage_users_owner_only: true,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { createCollabInvite } = await import("./collaborators");
    await expect(
      createCollabInvite({
        account_id: ACCOUNT_ID,
        invitee_account_id: TARGET_ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).rejects.toThrow("only project owners can invite collaborators");
  });

  it("creates pending viewer invites for existing accounts", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("AS actor_group")) {
        return {
          rows: [{ actor_group: "owner", manage_users_owner_only: false }],
        };
      }
      if (sql.includes("AS existing_group")) {
        return { rows: [{ existing_group: null }] };
      }
      if (sql.includes("FROM project_collab_invite_blocks")) {
        return { rows: [{ blocked: false }] };
      }
      if (
        sql.includes("SELECT invite_id") &&
        sql.includes("status='pending'")
      ) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO project_collab_invites")) {
        return { rows: [] };
      }
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: ACCOUNT_ID,
              invitee_account_id: TARGET_ACCOUNT_ID,
              invite_role: "viewer",
              read_policy: { rules: [{ action: "include", path: "." }] },
              status: "pending",
              created: new Date("2026-04-01T00:00:00Z"),
              updated: new Date("2026-04-01T00:00:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { createCollabInvite } = await import("./collaborators");
    await expect(
      createCollabInvite({
        account_id: ACCOUNT_ID,
        invitee_account_id: TARGET_ACCOUNT_ID,
        invite_role: "viewer",
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      created: true,
      invite: expect.objectContaining({
        invite_id: inviteId,
        invite_role: "viewer",
        read_policy: expect.objectContaining({ rules: expect.any(Array) }),
      }),
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_collab_invites"),
      expect.arrayContaining(["viewer"]),
    );
  });

  it("rejects email invites from collaborators when owner-only management is enabled", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("AS actor_group")) {
        return {
          rows: [
            {
              actor_group: "collaborator",
              manage_users_owner_only: true,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { inviteCollaboratorWithoutAccount } =
      await import("./collaborators");
    await expect(
      inviteCollaboratorWithoutAccount({
        account_id: ACCOUNT_ID,
        opts: {
          email: "Join",
          link2proj: "https://example.com/projects/test",
          project_id: PROJECT_ID,
          title: "Test Project",
          to: "new@example.com",
        },
      }),
    ).rejects.toThrow("only project owners can invite collaborators");
  });

  it("loads collaborators only for local projects", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        { account_id: ACCOUNT_ID, group: "owner", name: "Owner" },
        {
          account_id: TARGET_ACCOUNT_ID,
          group: "collaborator",
          name: "Collab",
        },
        {
          account_id: "44444444-4444-4444-8444-444444444444",
          group: "viewer",
          name: "Viewer",
        },
      ],
    }));
    const { listCollaborators } = await import("./collaborators");
    await expect(
      listCollaborators({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        group: "owner",
        name: "Owner",
      }),
      expect.objectContaining({
        account_id: TARGET_ACCOUNT_ID,
        group: "collaborator",
        name: "Collab",
      }),
      expect.objectContaining({
        account_id: "44444444-4444-4444-8444-444444444444",
        group: "viewer",
        name: "Viewer",
      }),
    ]);
    expect(assertProjectCollaboratorAccessAllowRemoteMock).toHaveBeenCalledWith(
      {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      },
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("loads collaborators from remote project references", async () => {
    assertProjectCollaboratorAccessAllowRemoteMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      title: "Remote Project",
      host_id: "55555555-5555-4555-8555-555555555555",
      owning_bay_id: "bay-7",
      users: {
        [TARGET_ACCOUNT_ID]: { group: "collaborator" },
        [ACCOUNT_ID]: { group: "owner" },
        ["44444444-4444-4444-8444-444444444444"]: { group: "viewer" },
      },
    }));
    getClusterAccountsByIdsMock = jest.fn(async (account_ids: string[]) =>
      account_ids.map((account_id) => ({
        account_id,
        name: account_id === ACCOUNT_ID ? "Remote Owner" : "Remote Collab",
      })),
    );
    const { listCollaborators } = await import("./collaborators");
    await expect(
      listCollaborators({
        account_id: TARGET_ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        group: "owner",
        name: "Remote Owner",
      }),
      expect.objectContaining({
        account_id: TARGET_ACCOUNT_ID,
        group: "collaborator",
        name: "Remote Collab",
      }),
      expect.objectContaining({
        account_id: "44444444-4444-4444-8444-444444444444",
        group: "viewer",
        name: "Remote Collab",
      }),
    ]);
    expect(assertProjectCollaboratorAccessAllowRemoteMock).toHaveBeenCalledWith(
      {
        account_id: TARGET_ACCOUNT_ID,
        project_id: PROJECT_ID,
      },
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("uses projected my-collaborator rows when enabled", async () => {
    process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS = "prefer";
    listProjectedMyCollaboratorsForAccountMock = jest.fn(async () => [
      {
        account_id: TARGET_ACCOUNT_ID,
        name: "Collab",
        first_name: "Col",
        last_name: "Lab",
        email_address: null,
        last_active: null,
        shared_projects: 3,
      },
    ]);
    const { listMyCollaborators } = await import("./collaborators");
    await expect(
      listMyCollaborators({
        account_id: ACCOUNT_ID,
        limit: 20,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: TARGET_ACCOUNT_ID,
        shared_projects: 3,
        name: "Collab",
      }),
    ]);
    expect(listProjectedMyCollaboratorsForAccountMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      limit: 20,
      include_email: false,
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("falls back to legacy my-collaborator reads in prefer mode when projection is empty", async () => {
    process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS = "prefer";
    queryMock = jest.fn(async () => ({
      rows: [
        {
          account_id: TARGET_ACCOUNT_ID,
          name: "Legacy Collab",
          shared_projects: 2,
        },
      ],
    }));
    const { listMyCollaborators } = await import("./collaborators");
    await expect(
      listMyCollaborators({
        account_id: ACCOUNT_ID,
        limit: 20,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: TARGET_ACCOUNT_ID,
        shared_projects: 2,
        name: "Legacy Collab",
      }),
    ]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("uses projection-only collaborator reads in only mode", async () => {
    process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS = "only";
    listProjectedMyCollaboratorsForAccountMock = jest.fn(async () => []);
    const { listMyCollaborators } = await import("./collaborators");
    await expect(
      listMyCollaborators({
        account_id: ACCOUNT_ID,
        limit: 20,
      }),
    ).resolves.toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("includes projected inbound invites for remote accounts", async () => {
    listProjectedInboundCollabInvitesMock = jest.fn(async () => [
      {
        invite_id: "55555555-5555-4555-8555-555555555555",
        project_id: PROJECT_ID,
        project_title: "Remote Project",
        inviter_account_id: TARGET_ACCOUNT_ID,
        inviter_name: "Remote Owner",
        invitee_account_id: ACCOUNT_ID,
        invitee_name: "Invitee",
        invite_source: "account",
        status: "pending",
        created: new Date("2026-04-08T21:00:00Z"),
        updated: new Date("2026-04-08T21:00:00Z"),
        responded: null,
        expires: new Date("2026-05-08T21:00:00Z"),
        shared_projects_count: 0,
        shared_projects_sample: [],
        prior_invites_accepted: 0,
        prior_invites_declined: 0,
      },
    ]);
    const { listCollabInvites } = await import("./collaborators");
    await expect(
      listCollabInvites({
        account_id: ACCOUNT_ID,
        direction: "inbound",
        status: "pending",
        limit: 20,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        invite_id: "55555555-5555-4555-8555-555555555555",
        project_title: "Remote Project",
        invite_source: "account",
        status: "pending",
      }),
    ]);
    expect(listProjectedInboundCollabInvitesMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: undefined,
      status: "pending",
      limit: 20,
    });
  });

  it("lists project-wide pending invites for project collaborators", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: "77777777-7777-4777-8777-777777777777",
              project_id: PROJECT_ID,
              project_title: "Test Project",
              inviter_account_id: TARGET_ACCOUNT_ID,
              inviter_name: "Other Sender",
              invitee_account_id: null,
              invite_source: "email",
              status: "pending",
              created: new Date("2026-04-08T21:00:00Z"),
              updated: new Date("2026-04-08T21:00:00Z"),
              responded: null,
              expires: new Date("2026-04-22T21:00:00Z"),
              shared_projects_count: 0,
              shared_projects_sample: [],
              prior_invites_accepted: 0,
              prior_invites_declined: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { listCollabInvites } = await import("./collaborators");
    await expect(
      listCollabInvites({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        projectWide: true,
        status: "pending",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        invite_id: "77777777-7777-4777-8777-777777777777",
        inviter_account_id: TARGET_ACCOUNT_ID,
        status: "pending",
      }),
    ]);
    expect(assertLocalProjectCollaboratorMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(listProjectedInboundCollabInvitesMock).not.toHaveBeenCalled();
  });

  it("lets a project collaborator revoke another sender's pending invite", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, invitee_account_id",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              invitee_account_id: null,
              invite_source: "email",
              status: "pending",
            },
          ],
        };
      }
      if (sql.includes("UPDATE project_collab_invites")) {
        return { rows: [] };
      }
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              invitee_account_id: null,
              invite_source: "email",
              status: "canceled",
              responder_action: "revoke",
              created: new Date("2026-04-08T21:00:00Z"),
              updated: new Date("2026-04-08T21:01:00Z"),
              responded: new Date("2026-04-08T21:01:00Z"),
              expires: new Date("2026-04-22T21:00:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { respondCollabInvite } = await import("./collaborators");
    await expect(
      respondCollabInvite({
        account_id: ACCOUNT_ID,
        invite_id: inviteId,
        action: "revoke",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        invite_id: inviteId,
        status: "canceled",
        responder_action: "revoke",
      }),
    );
    expect(assertLocalProjectCollaboratorMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
  });

  it("forwards projected invite responses to the source bay", async () => {
    queryMock = jest.fn(async () => ({ rows: [] }));
    respondProjectedInboundCollabInviteMock = jest.fn(async () => ({
      invite_id: "66666666-6666-4666-8666-666666666666",
      project_id: PROJECT_ID,
      inviter_account_id: TARGET_ACCOUNT_ID,
      invitee_account_id: ACCOUNT_ID,
      invite_source: "account",
      status: "accepted",
      responder_action: "accept",
      created: new Date("2026-04-08T21:00:00Z"),
      updated: new Date("2026-04-08T21:01:00Z"),
      responded: new Date("2026-04-08T21:01:00Z"),
      expires: new Date("2026-05-08T21:00:00Z"),
      shared_projects_count: 0,
      shared_projects_sample: [],
      prior_invites_accepted: 0,
      prior_invites_declined: 0,
    }));
    const { respondCollabInvite } = await import("./collaborators");
    await expect(
      respondCollabInvite({
        account_id: ACCOUNT_ID,
        invite_id: "66666666-6666-4666-8666-666666666666",
        action: "accept",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        invite_id: "66666666-6666-4666-8666-666666666666",
        status: "accepted",
        responder_action: "accept",
      }),
    );
    expect(respondProjectedInboundCollabInviteMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      invite_id: "66666666-6666-4666-8666-666666666666",
      action: "accept",
      includeEmail: false,
    });
    expect(assertAccountTrustedForProductAccessMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
      "accept collaboration invites",
    );
  });

  it("accepts viewer invites without granting collaborator access", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, invitee_account_id",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              invitee_account_id: ACCOUNT_ID,
              invite_role: "viewer",
              read_policy: { rules: [{ action: "include", path: "." }] },
              status: "pending",
            },
          ],
        };
      }
      if (sql.includes("AS inviter_group")) {
        return {
          rows: [{ inviter_group: "owner", manage_users_owner_only: false }],
        };
      }
      if (sql.includes("AS existing_group")) {
        return { rows: [{ existing_group: null }] };
      }
      if (sql.includes("UPDATE projects")) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE project_collab_invites")) {
        return { rows: [] };
      }
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              invitee_account_id: ACCOUNT_ID,
              invite_source: "account",
              invite_role: "viewer",
              read_policy: { rules: [{ action: "include", path: "." }] },
              status: "accepted",
              responder_action: "accept",
              created: new Date("2026-04-08T21:00:00Z"),
              updated: new Date("2026-04-08T21:01:00Z"),
              responded: new Date("2026-04-08T21:01:00Z"),
              expires: new Date("2026-05-08T21:00:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { respondCollabInvite } = await import("./collaborators");
    await expect(
      respondCollabInvite({
        account_id: ACCOUNT_ID,
        invite_id: inviteId,
        action: "accept",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        invite_id: inviteId,
        invite_role: "viewer",
        status: "accepted",
      }),
    );

    expect(addUserToProject).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        group: "viewer",
        project_id: PROJECT_ID,
      }),
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_set"),
      expect.arrayContaining([PROJECT_ID, ACCOUNT_ID, "viewer"]),
    );
    const { appendProjectOutboxEventForProject } =
      await import("@cocalc/database/postgres/project-events-outbox");
    expect(appendProjectOutboxEventForProject).toHaveBeenCalledWith({
      event_type: "project.membership_changed",
      project_id: PROJECT_ID,
    });
  });

  it("blocks untrusted accounts from accepting projected invites", async () => {
    queryMock = jest.fn(async () => ({ rows: [] }));
    assertAccountTrustedForProductAccessMock = jest.fn(async () => {
      throw new Error("verify");
    });

    const { respondCollabInvite } = await import("./collaborators");
    await expect(
      respondCollabInvite({
        account_id: ACCOUNT_ID,
        invite_id: "66666666-6666-4666-8666-666666666666",
        action: "accept",
      }),
    ).rejects.toThrow("verify");

    expect(respondProjectedInboundCollabInviteMock).not.toHaveBeenCalled();
  });

  it("stores inviter metadata for email-only invites", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("AS actor_group")) {
        return {
          rows: [{ actor_group: "owner", manage_users_owner_only: false }],
        };
      }
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: "77777777-7777-4777-8777-777777777777",
              project_id: PROJECT_ID,
              project_title: "Test Project",
              inviter_account_id: ACCOUNT_ID,
              invitee_account_id: null,
              invite_source: "email",
              status: "pending",
              message: "Please join",
              created: new Date("2026-04-01T00:00:00Z"),
              updated: new Date("2026-04-01T00:00:00Z"),
              responded: null,
              expires: new Date("2026-04-15T00:00:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { inviteCollaboratorWithoutAccount } =
      await import("./collaborators");
    const result = await inviteCollaboratorWithoutAccount({
      account_id: ACCOUNT_ID,
      opts: {
        project_id: PROJECT_ID,
        title: "Test Project",
        link2proj: "https://example.com/project",
        to: "nobody@example.com",
        email: "<p>Hello</p>",
        message: "Please join",
      },
    });
    expect(result.invites).toEqual([
      expect.objectContaining({
        invite_id: "77777777-7777-4777-8777-777777777777",
        invite_source: "email",
        target_email: "nobody@example.com",
        invite_url: expect.stringMatching(/\/invites\/[^/?#]+$/),
      }),
    ]);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_collab_invites"),
      expect.arrayContaining([
        expect.any(String),
        PROJECT_ID,
        ACCOUNT_ID,
        "email",
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        "Please join",
        "project_collab",
      ]),
    );
    expect(assertAccountTrustedForProductAccessMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
      "invite collaborators",
    );
  });

  it("shows the original target email on outgoing email-token invites", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: "77777777-7777-4777-8777-777777777777",
              project_id: PROJECT_ID,
              project_title: "Test Project",
              inviter_account_id: ACCOUNT_ID,
              invitee_account_id: null,
              invite_source: "email",
              email_ciphertext: encryptedInviteEmail("student@example.com"),
              status: "pending",
              created: new Date("2026-04-01T00:00:00Z"),
              updated: new Date("2026-04-01T00:00:00Z"),
              responded: null,
              expires: new Date("2026-04-15T00:00:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { listCollabInvites } = await import("./collaborators");
    await expect(
      listCollabInvites({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        direction: "outbound",
        status: "pending",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        invite_id: "77777777-7777-4777-8777-777777777777",
        invite_source: "email",
        invitee_email_address: null,
        target_email: "student@example.com",
      }),
    ]);
  });

  it("creates email-only invites when the email backend is unavailable", async () => {
    const emailModule = jest.requireMock("@cocalc/server/hub/email");
    emailModule.send_invite_email.mockImplementationOnce(
      async () => "no email sent, because email_backend is 'none'",
    );
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("AS actor_group")) {
        return {
          rows: [{ actor_group: "owner", manage_users_owner_only: false }],
        };
      }
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: "77777777-7777-4777-8777-777777777777",
              project_id: PROJECT_ID,
              project_title: "Test Project",
              inviter_account_id: ACCOUNT_ID,
              invitee_account_id: null,
              invite_source: "email",
              status: "pending",
              message: "Please join",
              created: new Date("2026-04-01T00:00:00Z"),
              updated: new Date("2026-04-01T00:00:00Z"),
              responded: null,
              expires: new Date("2026-04-15T00:00:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { inviteCollaboratorWithoutAccount } =
      await import("./collaborators");
    await expect(
      inviteCollaboratorWithoutAccount({
        account_id: ACCOUNT_ID,
        opts: {
          project_id: PROJECT_ID,
          title: "Test Project",
          link2proj: "https://example.com/project",
          to: "nobody@example.com",
          email: "<p>Hello</p>",
          message: "Please join",
        },
      }),
    ).resolves.toMatchObject({
      email_sent: false,
      email_available: false,
      manual_delivery_required: true,
      email_blocked_reason: "email_not_configured",
      invites: [
        expect.objectContaining({
          invite_url: expect.stringMatching(/\/invites\/[^/?#]+$/),
        }),
      ],
    });
  });

  it("blocks course email invites at the pending-per-course limit", async () => {
    resolveMembershipForAccountMock = jest.fn(async () => ({
      class: "instructor",
      source: "site-license",
      entitlements: {},
      effective_limits: {
        invite_email_recipients_per_batch: 10,
        invite_email_pending_per_project: 100,
        invite_email_pending_per_course: 2,
        invite_email_hourly_count: 100,
        invite_email_daily_count: 100,
        course_max_students_and_pending_invites: 100,
      },
    }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("AS actor_group")) {
        return {
          rows: [{ actor_group: "owner", manage_users_owner_only: false }],
        };
      }
      if (sql.includes("context ->> 'course_project_id'")) {
        return { rows: [{ count: 1 }] };
      }
      if (sql.includes("COUNT(*)::int AS count")) {
        return { rows: [{ count: 0 }] };
      }
      return { rows: [] };
    });

    const { inviteCollaboratorWithoutAccount } =
      await import("./collaborators");
    await expect(
      inviteCollaboratorWithoutAccount({
        account_id: ACCOUNT_ID,
        opts: {
          project_id: PROJECT_ID,
          title: "Test Course",
          link2proj: "",
          to: "one@example.com,two@example.com",
          email: "<p>Hello</p>",
          invite_scope: "course_student",
          invite_context: {
            course_project_id: "44444444-4444-4444-8444-444444444444",
          },
        },
      }),
    ).rejects.toThrow("course pending email invite limit reached (1/2)");
  });

  it("blocks course email invites at the total course student cap", async () => {
    resolveMembershipForAccountMock = jest.fn(async () => ({
      class: "instructor",
      source: "site-license",
      entitlements: {},
      effective_limits: {
        invite_email_recipients_per_batch: 10,
        invite_email_pending_per_project: 100,
        invite_email_pending_per_course: 100,
        invite_email_hourly_count: 100,
        invite_email_daily_count: 100,
        course_max_students_and_pending_invites: 3,
      },
    }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("AS actor_group")) {
        return {
          rows: [{ actor_group: "owner", manage_users_owner_only: false }],
        };
      }
      if (sql.includes("course ->> 'type' = 'student'")) {
        return { rows: [{ students: 3, pending_invites: 0 }] };
      }
      if (sql.includes("FROM projects AS p")) {
        return {
          rows: [
            {
              usage_account_id: null,
              course: null,
              owner_account_id: ACCOUNT_ID,
            },
          ],
        };
      }
      if (sql.includes("COUNT(*)::int AS count")) {
        return { rows: [{ count: 0 }] };
      }
      return { rows: [] };
    });

    const { inviteCollaboratorWithoutAccount } =
      await import("./collaborators");
    await expect(
      inviteCollaboratorWithoutAccount({
        account_id: ACCOUNT_ID,
        opts: {
          project_id: PROJECT_ID,
          title: "Test Course",
          link2proj: "",
          to: "student@example.com",
          email: "<p>Hello</p>",
          invite_scope: "course_student",
          invite_context: {
            course_project_id: "44444444-4444-4444-8444-444444444444",
          },
        },
      }),
    ).rejects.toThrow("course student limit reached (3/3)");
  });

  it("requires course context for course email invites", async () => {
    resolveMembershipForAccountMock = jest.fn(async () => ({
      class: "instructor",
      source: "site-license",
      entitlements: {},
      effective_limits: {
        invite_email_recipients_per_batch: 10,
      },
    }));

    const { inviteCollaboratorWithoutAccount } =
      await import("./collaborators");
    await expect(
      inviteCollaboratorWithoutAccount({
        account_id: ACCOUNT_ID,
        opts: {
          project_id: PROJECT_ID,
          title: "Test Course",
          link2proj: "",
          to: "student@example.com",
          email: "<p>Hello</p>",
          invite_scope: "course_student",
        },
      }),
    ).rejects.toThrow("course invite context is missing course_project_id");
  });

  it("migrates copied pending invite links to bay-independent token hashes", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const token = "copied-pending-token";
    const legacyHash = "project_collab_invites.email-token:v1:legacy";
    const tokenCiphertext = encryptSecretSettingValue(
      "project_collab_invites.token",
      token,
      Buffer.alloc(32, 1),
    );

    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT project_id, inviter_account_id, token_hash, token_ciphertext",
        )
      ) {
        return {
          rows: [
            {
              project_id: PROJECT_ID,
              inviter_account_id: ACCOUNT_ID,
              token_hash: legacyHash,
              token_ciphertext: tokenCiphertext,
              scope: "project_collab",
              status: "pending",
              created: new Date("2026-04-01T00:00:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { copyEmailProjectInviteLink } = await import("./collaborators");
    await expect(
      copyEmailProjectInviteLink({
        account_id: ACCOUNT_ID,
        invite_id: inviteId,
      }),
    ).resolves.toMatchObject({
      invite_id: inviteId,
      invite_url: "https://example.com/invites/copied-pending-token",
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET token_hash=$2"),
      [inviteId, inviteTokenHash(token)],
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_collab_invite_directory"),
      expect.arrayContaining([inviteId, PROJECT_ID, inviteTokenHash(token)]),
    );
  });

  it("does not let a non-owner collaborator copy another sender's email invite link", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const tokenCiphertext = encryptSecretSettingValue(
      "project_collab_invites.token",
      "leaked-token",
      Buffer.alloc(32, 1),
    );

    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT project_id, inviter_account_id, token_hash, token_ciphertext",
        )
      ) {
        return {
          rows: [
            {
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              token_hash: inviteTokenHash("leaked-token"),
              token_ciphertext: tokenCiphertext,
              scope: "project_collab",
              status: "pending",
              created: new Date("2026-04-01T00:00:00Z"),
            },
          ],
        };
      }
      if (sql.includes("AS is_owner")) {
        return { rows: [{ is_owner: false }] };
      }
      return { rows: [] };
    });

    const { copyEmailProjectInviteLink } = await import("./collaborators");
    await expect(
      copyEmailProjectInviteLink({
        account_id: ACCOUNT_ID,
        invite_id: inviteId,
      }),
    ).rejects.toThrow(
      "only the invite sender or a project owner can copy this invite link",
    );
  });

  it("binds accepted course email invites to the student project course field", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const token = "course-invite-token";
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes("UPDATE project_collab_invites") &&
        sql.includes("RETURNING")
      ) {
        return { rows: [] };
      }
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, status, token_hash",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              status: "pending",
              token_hash: inviteTokenHash(token),
            },
          ],
        };
      }
      if (sql.includes("AS inviter_group")) {
        return {
          rows: [
            {
              inviter_group: "owner",
              manage_users_owner_only: true,
            },
          ],
        };
      }
      if (sql.includes("SELECT EXISTS(")) {
        return { rows: [{ already: false }] };
      }
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, invitee_account_id",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              invitee_account_id: null,
              invite_source: "email",
              scope: "course_student",
              status: "pending",
            },
          ],
        };
      }
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              invitee_account_id: null,
              invite_source: "email",
              scope: "course_student",
              accepted_account_id: ACCOUNT_ID,
              status: "accepted",
              created: new Date("2026-04-01T00:00:00Z"),
              updated: new Date("2026-04-01T00:00:00Z"),
              responded: new Date("2026-04-01T00:00:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { redeemEmailProjectInvite } = await import("./collaborators");
    await expect(
      redeemEmailProjectInvite({
        account_id: ACCOUNT_ID,
        invite_id: inviteId,
        token,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        accepted_account_id: ACCOUNT_ID,
        scope: "course_student",
        status: "accepted",
      }),
    );
    expect(addUserToProject).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        group: "collaborator",
        project_id: PROJECT_ID,
      }),
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_set"),
      [PROJECT_ID, ACCOUNT_ID],
    );
  });

  it("rejects email invite acceptance when the sender is no longer a project collaborator", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const token = "stale-invite-token";
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, status, token_hash",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              status: "pending",
              token_hash: inviteTokenHash(token),
            },
          ],
        };
      }
      if (sql.includes("AS inviter_group")) {
        return {
          rows: [{ inviter_group: null, manage_users_owner_only: true }],
        };
      }
      return { rows: [] };
    });

    const { redeemEmailProjectInvite } = await import("./collaborators");
    await expect(
      redeemEmailProjectInvite({
        account_id: ACCOUNT_ID,
        invite_id: inviteId,
        token,
      }),
    ).rejects.toThrow("invite sender no longer has access");
    expect(addUserToProject).not.toHaveBeenCalled();
  });

  it("rejects email invite acceptance when owner-only management no longer allows the sender to grant access", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const token = "owner-only-stale-invite-token";
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, status, token_hash",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              status: "pending",
              token_hash: inviteTokenHash(token),
            },
          ],
        };
      }
      if (sql.includes("AS inviter_group")) {
        return {
          rows: [
            {
              inviter_group: "collaborator",
              manage_users_owner_only: true,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { redeemEmailProjectInvite } = await import("./collaborators");
    await expect(
      redeemEmailProjectInvite({
        account_id: ACCOUNT_ID,
        invite_id: inviteId,
        token,
      }),
    ).rejects.toThrow("invite sender is no longer allowed");
    expect(addUserToProject).not.toHaveBeenCalled();
  });

  it("rejects email invite acceptance when the sender is banned", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const token = "banned-sender-token";
    isAccountBannedCachedMock = jest.fn((account_id: string) => {
      return account_id === TARGET_ACCOUNT_ID;
    });
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, status, token_hash",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              status: "pending",
              token_hash: inviteTokenHash(token),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { redeemEmailProjectInvite } = await import("./collaborators");
    await expect(
      redeemEmailProjectInvite({
        account_id: ACCOUNT_ID,
        invite_id: inviteId,
        token,
      }),
    ).rejects.toThrow("invite sender is banned");
    expect(addUserToProject).not.toHaveBeenCalled();
    expect(ensureAccountSecurityStateReadyMock).toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("AS inviter_group"),
      expect.any(Array),
    );
  });

  it("previews email token invites without adding a collaborator", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const token = "preview-invite-token";
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, status, token_hash",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              status: "pending",
              token_hash: inviteTokenHash(token),
            },
          ],
        };
      }
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              project_title: "Test Project",
              inviter_account_id: TARGET_ACCOUNT_ID,
              inviter_name: "Inviter",
              invitee_account_id: null,
              invite_source: "email",
              status: "pending",
              message: "Please join",
              created: new Date("2026-04-01T00:00:00Z"),
              updated: new Date("2026-04-01T00:00:00Z"),
              responded: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { previewEmailProjectInvite } = await import("./collaborators");
    await expect(
      previewEmailProjectInvite({
        account_id: ACCOUNT_ID,
        invite_id: inviteId,
        project_id: PROJECT_ID,
        token,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        invite_id: inviteId,
        message: "Please join",
        status: "pending",
      }),
    );
    expect(addUserToProject).not.toHaveBeenCalled();
  });

  it("previews email token invites without requiring sign-in", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const token = "preview-public-token";
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, status, token_hash",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              status: "pending",
              token_hash: inviteTokenHash(token),
            },
          ],
        };
      }
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              project_title: "Test Project",
              inviter_account_id: TARGET_ACCOUNT_ID,
              inviter_name: "Inviter",
              invitee_account_id: null,
              invite_source: "email",
              status: "pending",
              message: "Please join",
              created: new Date("2026-04-01T00:00:00Z"),
              updated: new Date("2026-04-01T00:00:00Z"),
              responded: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { previewEmailProjectInvite } = await import("./collaborators");
    await expect(
      previewEmailProjectInvite({
        invite_id: inviteId,
        project_id: PROJECT_ID,
        token,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        invite_id: inviteId,
        status: "pending",
      }),
    );
  });

  it("checks email invite tokens before revealing expired status", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, status, token_hash",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              status: "expired",
              token_hash: inviteTokenHash("correct-token"),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { previewEmailProjectInvite } = await import("./collaborators");
    await expect(
      previewEmailProjectInvite({
        invite_id: inviteId,
        project_id: PROJECT_ID,
        token: "wrong-token",
      }),
    ).rejects.toThrow("invalid invite token");
    await expect(
      previewEmailProjectInvite({
        invite_id: inviteId,
        project_id: PROJECT_ID,
        token: "correct-token",
      }),
    ).rejects.toThrow("invite is not pending (status=expired)");
  });

  it("declines email token invites without adding a collaborator", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const token = "decline-invite-token";
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, status, token_hash",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              status: "pending",
              token_hash: inviteTokenHash(token),
            },
          ],
        };
      }
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              invitee_account_id: null,
              invite_source: "email",
              status: "declined",
              responder_action: "decline",
              created: new Date("2026-04-01T00:00:00Z"),
              updated: new Date("2026-04-01T00:01:00Z"),
              responded: new Date("2026-04-01T00:01:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { respondEmailProjectInvite } = await import("./collaborators");
    await expect(
      respondEmailProjectInvite({
        account_id: ACCOUNT_ID,
        action: "decline",
        invite_id: inviteId,
        project_id: PROJECT_ID,
        token,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        invite_id: inviteId,
        responder_action: "decline",
        status: "declined",
      }),
    );
    expect(addUserToProject).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET status=$2, responder_action=$3"),
      [inviteId, "declined", "decline"],
    );
  });

  it("blocks email token inviters without adding a collaborator", async () => {
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const token = "block-invite-token";
    queryMock = jest.fn(async (sql: string) => {
      if (
        sql.includes(
          "SELECT invite_id, project_id, inviter_account_id, status, token_hash",
        )
      ) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              status: "pending",
              token_hash: inviteTokenHash(token),
            },
          ],
        };
      }
      if (sql.includes("FROM project_collab_invites i")) {
        return {
          rows: [
            {
              invite_id: inviteId,
              project_id: PROJECT_ID,
              inviter_account_id: TARGET_ACCOUNT_ID,
              invitee_account_id: null,
              invite_source: "email",
              status: "blocked",
              responder_action: "block",
              created: new Date("2026-04-01T00:00:00Z"),
              updated: new Date("2026-04-01T00:01:00Z"),
              responded: new Date("2026-04-01T00:01:00Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { respondEmailProjectInvite } = await import("./collaborators");
    await expect(
      respondEmailProjectInvite({
        account_id: ACCOUNT_ID,
        action: "block",
        invite_id: inviteId,
        project_id: PROJECT_ID,
        token,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        invite_id: inviteId,
        responder_action: "block",
        status: "blocked",
      }),
    );
    expect(addUserToProject).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("project_collab_invite_blocks"),
      [ACCOUNT_ID, TARGET_ACCOUNT_ID],
    );
  });

  it("blocks untrusted accounts from creating email-only invites", async () => {
    assertAccountTrustedForProductAccessMock = jest.fn(async () => {
      throw new Error("verify");
    });
    const { inviteCollaboratorWithoutAccount } =
      await import("./collaborators");

    await expect(
      inviteCollaboratorWithoutAccount({
        account_id: ACCOUNT_ID,
        opts: {
          project_id: PROJECT_ID,
          title: "Test Project",
          link2proj: "https://example.com/project",
          to: "nobody@example.com",
          email: "<p>Hello</p>",
        },
      }),
    ).rejects.toThrow("verify");
  });
});
