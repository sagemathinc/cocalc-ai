/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { applyRemoteProjectToAccountCollaboratorIndex } from "./account-collaborator-index-projector";
import {
  listProjectedCollaboratorsForAccount,
  listProjectedMyCollaboratorsForAccount,
  refreshProjectedCollaboratorIdentityRows,
  rebuildAccountCollaboratorIndex,
} from "./account-collaborator-index";

const LOCAL_BAY_ID = "bay-local";
const OTHER_BAY_ID = "bay-other";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const COLLAB_A = "22222222-2222-4222-8222-222222222222";
const COLLAB_B = "33333333-3333-4333-8333-333333333333";
const DELETED_COLLAB = "44444444-4444-4444-8444-444444444444";
const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_DELETED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("account_collaborator_index rebuild", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      "TRUNCATE account_collaborator_index, account_project_index, projects, accounts, cluster_account_directory CASCADE",
    );
  });

  afterAll(async () => {
    await testCleanup();
  });

  it.each(["owner", "collaborator", "viewer", "admin", null])(
    "retains requester role semantics for %s when using the users key predicate",
    async (group) => {
      await getPool().query(
        `INSERT INTO accounts (account_id, home_bay_id) VALUES ($1, $2)`,
        [ACCOUNT_ID, LOCAL_BAY_ID],
      );
      const users = {
        ...(group == null ? {} : { [ACCOUNT_ID]: { group } }),
        [COLLAB_A]: { group: "collaborator" },
        [COLLAB_B]: { group: "viewer" },
      };
      await getPool().query(
        `INSERT INTO projects (project_id, users, deleted)
         VALUES ($1, $3::JSONB, FALSE), ($2, $3::JSONB, TRUE)`,
        [PROJECT_A, PROJECT_DELETED, JSON.stringify(users)],
      );
      const allowed = group === "owner" || group === "collaborator";
      await expect(
        rebuildAccountCollaboratorIndex({
          account_id: ACCOUNT_ID,
          bay_id: LOCAL_BAY_ID,
          dry_run: false,
        }),
      ).resolves.toMatchObject({
        source_project_rows: allowed ? 1 : 0,
        source_collaborator_rows: allowed ? 2 : 0,
        inserted_rows: allowed ? 2 : 0,
      });
      const rows = await listProjectedMyCollaboratorsForAccount({
        account_id: ACCOUNT_ID,
      });
      expect(rows.map((row) => row.account_id)).toEqual(
        allowed ? [COLLAB_A] : [],
      );
    },
  );

  it("rebuilds projected collaborator summaries for a home-bay account", async () => {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id, profile)
       VALUES
         ($1, 'Local', 'User', NOW(), 'local@example.com', $4, '{"image":"local.png"}'::JSONB),
         ($2, 'Alice', 'A', NOW(), 'alice@example.com', $4, '{"image":"alice.png"}'::JSONB),
         ($3, 'Bob', 'B', NOW(), 'bob@example.com', $5, '{"image":"bob.png"}'::JSONB)`,
      [ACCOUNT_ID, COLLAB_A, COLLAB_B, LOCAL_BAY_ID, OTHER_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
        (project_id, title, users, created, last_edited, deleted)
       VALUES
        ($1, 'Shared A', $4::JSONB, NOW(), NOW(), FALSE),
        ($2, 'Shared B', $5::JSONB, NOW(), NOW(), FALSE),
        ($3, 'Deleted Shared', $6::JSONB, NOW(), NOW(), TRUE)`,
      [
        PROJECT_A,
        PROJECT_B,
        PROJECT_DELETED,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
          [COLLAB_A]: { group: "collaborator" },
          [COLLAB_B]: { group: "collaborator" },
        }),
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
          [COLLAB_A]: { group: "collaborator" },
        }),
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
          [DELETED_COLLAB]: { group: "collaborator" },
        }),
      ],
    );

    await expect(
      rebuildAccountCollaboratorIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
      }),
    ).resolves.toMatchObject({
      bay_id: LOCAL_BAY_ID,
      target_account_id: ACCOUNT_ID,
      dry_run: true,
      existing_rows: 0,
      source_project_rows: 2,
      source_collaborator_rows: 3,
      deleted_rows: 0,
      inserted_rows: 0,
    });

    await expect(
      rebuildAccountCollaboratorIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      bay_id: LOCAL_BAY_ID,
      target_account_id: ACCOUNT_ID,
      dry_run: false,
      existing_rows: 0,
      source_project_rows: 2,
      source_collaborator_rows: 3,
      deleted_rows: 0,
      inserted_rows: 3,
    });

    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_ID,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        collaborator_account_id: ACCOUNT_ID,
        common_project_count: 2,
        first_name: "Local",
        last_name: "User",
        name: "Local User",
        profile: { image: "local.png" },
      }),
      expect.objectContaining({
        collaborator_account_id: COLLAB_A,
        common_project_count: 2,
        first_name: "Alice",
        last_name: "A",
        name: "Alice A",
        profile: { image: "alice.png" },
      }),
      expect.objectContaining({
        collaborator_account_id: COLLAB_B,
        common_project_count: 1,
        first_name: "Bob",
        last_name: "B",
        name: "Bob B",
        profile: { image: "bob.png" },
      }),
    ]);

    await expect(
      listProjectedMyCollaboratorsForAccount({
        account_id: ACCOUNT_ID,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: COLLAB_A,
        shared_projects: 2,
        name: "Alice A",
        first_name: "Alice",
        last_name: "A",
      }),
      expect.objectContaining({
        account_id: COLLAB_B,
        shared_projects: 1,
        name: "Bob B",
        first_name: "Bob",
        last_name: "B",
      }),
    ]);
  });

  it("projects deleted collaborators as Deleted User", async () => {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Local', 'User', NOW(), 'local@example.com', $2)`,
      [ACCOUNT_ID, LOCAL_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
        (project_id, title, users, created, last_edited, deleted)
       VALUES
        ($1, 'Shared', $2::JSONB, NOW(), NOW(), FALSE)`,
      [
        PROJECT_A,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
          [DELETED_COLLAB]: { group: "collaborator" },
        }),
      ],
    );

    await rebuildAccountCollaboratorIndex({
      account_id: ACCOUNT_ID,
      bay_id: LOCAL_BAY_ID,
      dry_run: false,
    });

    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_ID,
        limit: 10,
        collaborator_account_id: DELETED_COLLAB,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        collaborator_account_id: DELETED_COLLAB,
        common_project_count: 1,
        first_name: "Deleted",
        last_name: "User",
        name: "Deleted User",
        profile: null,
      }),
    ]);
  });

  it("refreshes projected collaborator identity rows after an account rename", async () => {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id, profile)
       VALUES
         ($1, 'Local', 'User', NOW(), 'local@example.com', $3, '{"image":"local.png"}'::JSONB),
         ($2, 'Alice', 'A', NOW(), 'alice@example.com', $3, '{"image":"alice.png"}'::JSONB)`,
      [ACCOUNT_ID, COLLAB_A, LOCAL_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
        (project_id, title, users, created, last_edited, deleted)
       VALUES
        ($1, 'Shared A', $2::JSONB, NOW(), NOW(), FALSE)`,
      [
        PROJECT_A,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
          [COLLAB_A]: { group: "collaborator" },
        }),
      ],
    );

    await rebuildAccountCollaboratorIndex({
      account_id: ACCOUNT_ID,
      bay_id: LOCAL_BAY_ID,
      dry_run: false,
    });

    await getPool().query(
      `UPDATE accounts
          SET first_name = 'Alicia',
              last_name = 'Anderson',
              profile = '{"image":"alicia.png","color":"#123456"}'::JSONB
        WHERE account_id = $1`,
      [COLLAB_A],
    );

    await expect(
      refreshProjectedCollaboratorIdentityRows({
        db: getPool(),
        collaborator_account_id: COLLAB_A,
      }),
    ).resolves.toEqual({
      updated_rows: [
        expect.objectContaining({
          account_id: ACCOUNT_ID,
          collaborator_account_id: COLLAB_A,
          first_name: "Alicia",
          last_name: "Anderson",
          name: "Alicia Anderson",
          profile: {
            image: "alicia.png",
            color: "#123456",
          },
        }),
      ],
    });
  });

  it("projects remote collaborator identity from the cluster directory", async () => {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id, profile)
       VALUES
         ($1, 'Local', 'User', NOW(), 'local@example.com', $2, '{"image":"local.png"}'::JSONB)`,
      [ACCOUNT_ID, LOCAL_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO cluster_account_directory
         (account_id, email_address, first_name, last_name, home_bay_id, provisioned)
       VALUES
         ($1, 'remote@example.com', 'Remote', 'Friend', $2, TRUE)`,
      [COLLAB_B, OTHER_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
        (project_id, title, users, created, last_edited, deleted)
       VALUES
        ($1, 'Shared', $2::JSONB, NOW(), NOW(), FALSE)`,
      [
        PROJECT_A,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
          [COLLAB_B]: { group: "collaborator" },
        }),
      ],
    );

    await rebuildAccountCollaboratorIndex({
      account_id: ACCOUNT_ID,
      bay_id: LOCAL_BAY_ID,
      dry_run: false,
    });

    await expect(
      listProjectedCollaboratorsForAccount({
        account_id: ACCOUNT_ID,
        collaborator_account_id: COLLAB_B,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        collaborator_account_id: COLLAB_B,
        first_name: "Remote",
        last_name: "Friend",
        name: "Remote Friend",
        profile: null,
      }),
    ]);

    await expect(
      listProjectedMyCollaboratorsForAccount({
        account_id: ACCOUNT_ID,
        include_email: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: COLLAB_B,
        first_name: "Remote",
        last_name: "Friend",
        name: "Remote Friend",
        email_address: "remote@example.com",
      }),
    ]);
  });

  it("skips viewer-only relationships during rebuild", async () => {
    const VIEWER_ONLY = "55555555-5555-4555-8555-555555555555";
    const PROJECT_VIEWER_PEER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const PROJECT_VIEWER_SELF = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Local', 'User', NOW(), 'local@example.com', $4),
         ($2, 'Alice', 'A', NOW(), 'alice@example.com', $4),
         ($3, 'Viewer', 'Peer', NOW(), 'viewer-peer@example.com', $4)`,
      [ACCOUNT_ID, COLLAB_A, VIEWER_ONLY, LOCAL_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
        (project_id, title, users, created, last_edited, deleted)
       VALUES
        ($1, 'Owner + Collaborator', $4::JSONB, NOW(), NOW(), FALSE),
        ($2, 'Owner + Viewer', $5::JSONB, NOW(), NOW(), FALSE),
        ($3, 'Viewer Self', $6::JSONB, NOW(), NOW(), FALSE)`,
      [
        PROJECT_A,
        PROJECT_VIEWER_PEER,
        PROJECT_VIEWER_SELF,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
          [COLLAB_A]: { group: "collaborator" },
        }),
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
          [VIEWER_ONLY]: { group: "viewer" },
        }),
        JSON.stringify({
          [ACCOUNT_ID]: { group: "viewer" },
          [COLLAB_A]: { group: "owner" },
        }),
      ],
    );

    await expect(
      rebuildAccountCollaboratorIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
      }),
    ).resolves.toMatchObject({
      source_project_rows: 2,
      source_collaborator_rows: 2,
    });

    await rebuildAccountCollaboratorIndex({
      account_id: ACCOUNT_ID,
      bay_id: LOCAL_BAY_ID,
      dry_run: false,
    });

    await expect(
      listProjectedMyCollaboratorsForAccount({
        account_id: ACCOUNT_ID,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        account_id: COLLAB_A,
        shared_projects: 1,
      }),
    ]);
  });

  it("rejects accounts homed in another bay", async () => {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Wrong', 'Bay', NOW(), 'wrong@example.com', $2)`,
      [ACCOUNT_ID, OTHER_BAY_ID],
    );

    await expect(
      rebuildAccountCollaboratorIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
      }),
    ).rejects.toThrow(
      `account '${ACCOUNT_ID}' is not homed in bay '${LOCAL_BAY_ID}'`,
    );
  });

  async function indexProject(
    project_id: string,
    users: Record<string, { group: string }>,
    owning_bay_id = OTHER_BAY_ID,
  ) {
    await getPool().query(
      `INSERT INTO account_project_index
         (account_id, project_id, owning_bay_id, users_summary, updated_at)
       VALUES ($1, $2, $3, $4::JSONB, NOW())
       ON CONFLICT (account_id, project_id)
       DO UPDATE SET users_summary = EXCLUDED.users_summary`,
      [ACCOUNT_ID, project_id, owning_bay_id, JSON.stringify(users)],
    );
  }

  const collaboratorIds = async () =>
    (await listProjectedMyCollaboratorsForAccount({ account_id: ACCOUNT_ID }))
      .map((row) => row.account_id)
      .sort();

  it("counts projects owned by other bays, from the account's project index", async () => {
    await getPool().query(
      `INSERT INTO accounts (account_id, home_bay_id) VALUES ($1, $2)`,
      [ACCOUNT_ID, LOCAL_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects (project_id, users, owning_bay_id) VALUES ($1, $2::JSONB, $3)`,
      [
        PROJECT_A,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
          [COLLAB_A]: { group: "collaborator" },
        }),
        LOCAL_BAY_ID,
      ],
    );
    // Only the index knows this one: it lives on another bay.
    await indexProject(PROJECT_B, {
      [ACCOUNT_ID]: { group: "collaborator" },
      [COLLAB_B]: { group: "owner" },
    });
    await expect(
      rebuildAccountCollaboratorIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
        dry_run: false,
      }),
    ).resolves.toMatchObject({
      source_project_rows: 2,
      // The account's own row, as for local projects, and one per peer.
      inserted_rows: 3,
    });
    expect(await collaboratorIds()).toEqual([COLLAB_A, COLLAB_B].sort());
  });

  it("a local copy of another bay's project is never used; the index decides", async () => {
    await getPool().query(
      `INSERT INTO accounts (account_id, home_bay_id) VALUES ($1, $2)`,
      [ACCOUNT_ID, LOCAL_BAY_ID],
    );
    // A stale copy says COLLAB_A; the owning bay's current users say COLLAB_B.
    await getPool().query(
      `INSERT INTO projects (project_id, users, owning_bay_id) VALUES ($1, $2::JSONB, $3)`,
      [
        PROJECT_B,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
          [COLLAB_A]: { group: "collaborator" },
        }),
        OTHER_BAY_ID,
      ],
    );
    const rebuild = () =>
      rebuildAccountCollaboratorIndex({
        account_id: ACCOUNT_ID,
        bay_id: LOCAL_BAY_ID,
        dry_run: false,
      });
    // Without an index row the copy still doesn't count: it may be stale, and
    // no row can mean the owning bay removed the account.
    await rebuild();
    expect(await collaboratorIds()).toEqual([]);
    await indexProject(PROJECT_B, {
      [ACCOUNT_ID]: { group: "owner" },
      [COLLAB_B]: { group: "collaborator" },
    });
    await rebuild();
    expect(await collaboratorIds()).toEqual([COLLAB_B]);
  });

  it("a forwarded change on the home bay adds, keeps and removes collaborators", async () => {
    await getPool().query(
      `INSERT INTO accounts (account_id, home_bay_id) VALUES ($1, $2)`,
      [ACCOUNT_ID, LOCAL_BAY_ID],
    );
    const apply = async (
      previous_users: Record<string, any> | null,
      current_users: Record<string, any> | null,
    ) => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        if (current_users == null) {
          await client.query(
            "DELETE FROM account_project_index WHERE account_id = $1 AND project_id = $2",
            [ACCOUNT_ID, PROJECT_B],
          );
        }
        const result = await applyRemoteProjectToAccountCollaboratorIndex({
          db: client,
          bay_id: LOCAL_BAY_ID,
          account_id: ACCOUNT_ID,
          previous_users,
          current_users,
        });
        await client.query("COMMIT");
        return result.feed_events.map((event) => event.type);
      } finally {
        client.release();
      }
    };
    const users = {
      [ACCOUNT_ID]: { group: "collaborator" },
      [COLLAB_B]: { group: "owner" },
    };
    await indexProject(PROJECT_B, users);
    // Invited: COLLAB_B appears, with a feed event.
    expect(await apply({ [COLLAB_B]: { group: "owner" } }, users)).toEqual([
      "collaborator.upsert",
    ]);
    expect(await collaboratorIds()).toEqual([COLLAB_B]);
    // Routine activity, same members: nothing to do.
    expect(await apply(users, users)).toEqual([]);
    // Same members but the row was lost: repaired.
    await getPool().query("TRUNCATE account_collaborator_index");
    expect(await apply(users, users)).toEqual(["collaborator.upsert"]);
    expect(await collaboratorIds()).toEqual([COLLAB_B]);
    // Removed from the project: gone, even with a stale local copy of the
    // project that still lists both, and a later rebuild doesn't bring it back.
    await getPool().query(
      `INSERT INTO projects (project_id, users, owning_bay_id) VALUES ($1, $2::JSONB, $3)`,
      [PROJECT_B, JSON.stringify(users), OTHER_BAY_ID],
    );
    expect(await apply(users, null)).toEqual(["collaborator.remove"]);
    expect(await collaboratorIds()).toEqual([]);
    await rebuildAccountCollaboratorIndex({
      account_id: ACCOUNT_ID,
      bay_id: LOCAL_BAY_ID,
      dry_run: false,
    });
    expect(await collaboratorIds()).toEqual([]);
  });
});
