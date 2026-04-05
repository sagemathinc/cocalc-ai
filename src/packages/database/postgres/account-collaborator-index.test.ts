/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
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
      "TRUNCATE account_collaborator_index, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await testCleanup();
  });

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
});
