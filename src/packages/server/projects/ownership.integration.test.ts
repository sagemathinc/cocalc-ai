/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { drainAccountProjectIndexProjection } from "@cocalc/database/postgres/account-project-index-projector";

const publishAccountFeedEventBestEffortMock = jest.fn();
const syncProjectUsersOnHostMock = jest.fn();
const hardDeleteProjectMock = jest.fn();

jest.mock("@cocalc/server/account/feed", () => ({
  __esModule: true,
  publishAccountFeedEventBestEffort: (...args: any[]) =>
    publishAccountFeedEventBestEffortMock(...args),
}));

jest.mock("../account/feed", () => ({
  __esModule: true,
  publishAccountFeedEventBestEffort: (...args: any[]) =>
    publishAccountFeedEventBestEffortMock(...args),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  syncProjectUsersOnHost: (...args: any[]) =>
    syncProjectUsersOnHostMock(...args),
}));

jest.mock("@cocalc/server/projects/hard-delete", () => ({
  __esModule: true,
  hardDeleteProject: (...args: any[]) => hardDeleteProjectMock(...args),
}));

const ACCOUNT_DELETING = "11111111-1111-4111-8111-111111111111";
const TRANSFER_TARGET = "22222222-2222-4222-8222-222222222222";
const EXISTING_OWNER = "33333333-3333-4333-8333-333333333333";
const OWNED_PROJECT = "44444444-4444-4444-8444-444444444444";
const COLLAB_PROJECT = "55555555-5555-4555-8555-555555555555";
const BAY_ID = "bay-0";

function feedEvents() {
  return publishAccountFeedEventBestEffortMock.mock.calls.map(
    ([call]) => call.event,
  );
}

async function seedAccounts(): Promise<void> {
  await getPool().query(
    `INSERT INTO accounts
       (account_id, first_name, last_name, created, email_address, home_bay_id)
     VALUES
       ($1, 'Deleting', 'Owner', NOW(), 'deleting-owner@example.com', $4),
       ($2, 'Transfer', 'Target', NOW(), 'transfer-target@example.com', $4),
       ($3, 'Existing', 'Owner', NOW(), 'existing-owner@example.com', $4)`,
    [ACCOUNT_DELETING, TRANSFER_TARGET, EXISTING_OWNER, BAY_ID],
  );
}

async function seedProject({
  project_id,
  title,
  users,
  last_active,
}: {
  project_id: string;
  title: string;
  users: Record<string, any>;
  last_active: Record<string, string>;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO projects
       (project_id, title, description, users, state, owning_bay_id,
        created, last_edited, last_active, usage_account_id,
        runtime_sponsor_account_id)
     VALUES
       ($1, $2, 'integration test', $3::jsonb, $4::jsonb, $5,
        $6, $7, $8::jsonb, $9, $9)`,
    [
      project_id,
      title,
      JSON.stringify(users),
      JSON.stringify({ state: "running" }),
      BAY_ID,
      new Date("2026-05-16T12:00:00.000Z"),
      new Date("2026-05-16T12:30:00.000Z"),
      JSON.stringify(last_active),
      Object.entries(users).find(([, user]) => user.group === "owner")?.[0] ??
        null,
    ],
  );
}

async function seedProjectedProjectRows({
  project_id,
  title,
  account_ids,
  users,
}: {
  project_id: string;
  title: string;
  account_ids: string[];
  users: Record<string, any>;
}): Promise<void> {
  for (const account_id of account_ids) {
    await getPool().query(
      `INSERT INTO account_project_index
         (account_id, project_id, owning_bay_id, host_id, title, description,
          theme, users_summary, state_summary, last_edited, last_backup,
          last_activity_at, last_opened_at, is_hidden, sort_key, updated_at)
       VALUES
         ($1, $2, $3, NULL, $4, 'old projection', '{}'::jsonb, $5::jsonb,
          $6::jsonb, $7, NULL, $7, $7, FALSE, $7, $7)`,
      [
        account_id,
        project_id,
        BAY_ID,
        title,
        JSON.stringify(users),
        JSON.stringify({ state: "running" }),
        new Date("2026-05-16T12:30:00.000Z"),
      ],
    );
  }
}

async function projectUsers(project_id: string): Promise<Record<string, any>> {
  const { rows } = await getPool().query<{ users: Record<string, any> }>(
    "SELECT users FROM projects WHERE project_id = $1",
    [project_id],
  );
  return rows[0]?.users ?? {};
}

async function projectedUsers({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<Record<string, any> | undefined> {
  const { rows } = await getPool().query<{
    users_summary: Record<string, any>;
  }>(
    `SELECT users_summary
       FROM account_project_index
      WHERE account_id = $1
        AND project_id = $2`,
    [account_id, project_id],
  );
  return rows[0]?.users_summary;
}

async function projectedProjectCount({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<number> {
  const { rows } = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM account_project_index
      WHERE account_id = $1
        AND project_id = $2`,
    [account_id, project_id],
  );
  return rows[0]?.count ?? 0;
}

describe("project ownership transfer integration", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  beforeEach(() => {
    publishAccountFeedEventBestEffortMock.mockResolvedValue(undefined);
    syncProjectUsersOnHostMock.mockResolvedValue(undefined);
    hardDeleteProjectMock.mockResolvedValue({ project_id: OWNED_PROJECT });
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await getPool().query(
      "TRUNCATE account_project_index, project_events_outbox, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("account deletion transfers shared projects and refreshes old/new owner projections", async () => {
    await seedAccounts();
    const initialUsers = {
      [ACCOUNT_DELETING]: { group: "owner" },
      [TRANSFER_TARGET]: { group: "collaborator" },
    };
    await seedProject({
      project_id: OWNED_PROJECT,
      title: "Account deletion transfer",
      users: initialUsers,
      last_active: {
        [ACCOUNT_DELETING]: "2026-05-16T12:00:00.000Z",
        [TRANSFER_TARGET]: "2026-05-16T12:20:00.000Z",
      },
    });
    await seedProjectedProjectRows({
      project_id: OWNED_PROJECT,
      title: "Account deletion transfer",
      account_ids: [ACCOUNT_DELETING, TRANSFER_TARGET],
      users: initialUsers,
    });

    const { disposeOwnedProjectsForAccountDeletion } =
      await import("./ownership");
    await expect(
      disposeOwnedProjectsForAccountDeletion(ACCOUNT_DELETING),
    ).resolves.toEqual([
      {
        project_id: OWNED_PROJECT,
        action: "transferred",
        new_owner_account_id: TRANSFER_TARGET,
      },
    ]);

    const users = await projectUsers(OWNED_PROJECT);
    expect(users[ACCOUNT_DELETING]).toBeUndefined();
    expect(users[TRANSFER_TARGET]?.group).toBe("owner");
    expect(hardDeleteProjectMock).not.toHaveBeenCalled();

    expect(feedEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "project.remove",
          account_id: ACCOUNT_DELETING,
          project_id: OWNED_PROJECT,
        }),
        expect.objectContaining({
          type: "project.upsert",
          account_id: TRANSFER_TARGET,
          project: expect.objectContaining({
            project_id: OWNED_PROJECT,
            users: expect.objectContaining({
              [TRANSFER_TARGET]: expect.objectContaining({ group: "owner" }),
            }),
          }),
        }),
      ]),
    );

    await drainAccountProjectIndexProjection({
      bay_id: BAY_ID,
      limit: 10,
      dry_run: false,
    });

    await expect(
      projectedProjectCount({
        account_id: ACCOUNT_DELETING,
        project_id: OWNED_PROJECT,
      }),
    ).resolves.toBe(0);
    await expect(
      projectedUsers({
        account_id: TRANSFER_TARGET,
        project_id: OWNED_PROJECT,
      }),
    ).resolves.toMatchObject({
      [TRANSFER_TARGET]: { group: "owner" },
    });
  });

  it("bulk leave/delete transfers owned projects, removes collaborator projects, and refreshes projections", async () => {
    await seedAccounts();
    const ownedUsers = {
      [ACCOUNT_DELETING]: { group: "owner" },
      [TRANSFER_TARGET]: { group: "collaborator" },
    };
    const collaboratorUsers = {
      [EXISTING_OWNER]: { group: "owner" },
      [ACCOUNT_DELETING]: { group: "collaborator" },
    };
    await seedProject({
      project_id: OWNED_PROJECT,
      title: "Bulk transfer",
      users: ownedUsers,
      last_active: {
        [ACCOUNT_DELETING]: "2026-05-16T12:00:00.000Z",
        [TRANSFER_TARGET]: "2026-05-16T12:40:00.000Z",
      },
    });
    await seedProject({
      project_id: COLLAB_PROJECT,
      title: "Bulk remove self",
      users: collaboratorUsers,
      last_active: {
        [EXISTING_OWNER]: "2026-05-16T12:30:00.000Z",
        [ACCOUNT_DELETING]: "2026-05-16T12:35:00.000Z",
      },
    });
    await seedProjectedProjectRows({
      project_id: OWNED_PROJECT,
      title: "Bulk transfer",
      account_ids: [ACCOUNT_DELETING, TRANSFER_TARGET],
      users: ownedUsers,
    });
    await seedProjectedProjectRows({
      project_id: COLLAB_PROJECT,
      title: "Bulk remove self",
      account_ids: [ACCOUNT_DELETING, EXISTING_OWNER],
      users: collaboratorUsers,
    });

    const { leaveOrDeleteProjectsForAccount } = await import("./ownership");
    await expect(
      leaveOrDeleteProjectsForAccount({
        account_id: ACCOUNT_DELETING,
        project_ids: [OWNED_PROJECT, COLLAB_PROJECT],
      }),
    ).resolves.toEqual([
      {
        project_id: OWNED_PROJECT,
        action: "transferred",
        new_owner_account_id: TRANSFER_TARGET,
      },
      {
        project_id: COLLAB_PROJECT,
        action: "removed_self",
      },
    ]);

    await expect(projectUsers(OWNED_PROJECT)).resolves.toMatchObject({
      [TRANSFER_TARGET]: { group: "owner" },
    });
    expect(
      (await projectUsers(OWNED_PROJECT))[ACCOUNT_DELETING],
    ).toBeUndefined();
    await expect(projectUsers(COLLAB_PROJECT)).resolves.toMatchObject({
      [EXISTING_OWNER]: { group: "owner" },
    });
    expect(
      (await projectUsers(COLLAB_PROJECT))[ACCOUNT_DELETING],
    ).toBeUndefined();

    expect(feedEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "project.remove",
          account_id: ACCOUNT_DELETING,
          project_id: OWNED_PROJECT,
        }),
        expect.objectContaining({
          type: "project.remove",
          account_id: ACCOUNT_DELETING,
          project_id: COLLAB_PROJECT,
        }),
        expect.objectContaining({
          type: "project.upsert",
          account_id: TRANSFER_TARGET,
          project: expect.objectContaining({ project_id: OWNED_PROJECT }),
        }),
        expect.objectContaining({
          type: "project.upsert",
          account_id: EXISTING_OWNER,
          project: expect.objectContaining({ project_id: COLLAB_PROJECT }),
        }),
      ]),
    );

    await drainAccountProjectIndexProjection({
      bay_id: BAY_ID,
      limit: 10,
      dry_run: false,
    });

    await expect(
      projectedProjectCount({
        account_id: ACCOUNT_DELETING,
        project_id: OWNED_PROJECT,
      }),
    ).resolves.toBe(0);
    await expect(
      projectedProjectCount({
        account_id: ACCOUNT_DELETING,
        project_id: COLLAB_PROJECT,
      }),
    ).resolves.toBe(0);
    await expect(
      projectedUsers({
        account_id: TRANSFER_TARGET,
        project_id: OWNED_PROJECT,
      }),
    ).resolves.toMatchObject({
      [TRANSFER_TARGET]: { group: "owner" },
    });
    await expect(
      projectedUsers({
        account_id: EXISTING_OWNER,
        project_id: COLLAB_PROJECT,
      }),
    ).resolves.toMatchObject({
      [EXISTING_OWNER]: { group: "owner" },
    });
  });
});
