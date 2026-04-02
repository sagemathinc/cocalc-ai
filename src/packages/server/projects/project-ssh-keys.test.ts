/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import sshKeys from "./get-ssh-keys";
import {
  deleteProjectSshKeyInDb,
  upsertProjectSshKeyInDb,
} from "./project-ssh-keys";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

describe("project SSH keys", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query("DELETE FROM projects");
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("persists the first project-specific SSH key and removes it cleanly", async () => {
    await getPool().query(
      "INSERT INTO projects (project_id, title, users, last_edited) VALUES ($1, $2, $3, NOW())",
      [
        PROJECT_ID,
        "Test Project",
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
        }),
      ],
    );

    expect(
      await upsertProjectSshKeyInDb({
        project_id: PROJECT_ID,
        account_id: ACCOUNT_ID,
        fingerprint: "fp-1",
        payload: {
          title: "laptop",
          value: "ssh-ed25519 AAAATEST laptop",
          creation_date: 123,
        },
      }),
    ).toBe(true);

    const {
      rows: [row],
    } = await getPool().query(
      "SELECT users -> $2::text -> 'ssh_keys' AS ssh_keys FROM projects WHERE project_id = $1",
      [PROJECT_ID, ACCOUNT_ID],
    );
    expect(row?.ssh_keys).toEqual({
      "fp-1": {
        title: "laptop",
        value: "ssh-ed25519 AAAATEST laptop",
        creation_date: 123,
      },
    });

    expect(await sshKeys(PROJECT_ID)).toEqual({
      "fp-1": {
        account_id: ACCOUNT_ID,
        title: "laptop",
        value: "ssh-ed25519 AAAATEST laptop",
        creation_date: 123,
      },
    });

    expect(
      await deleteProjectSshKeyInDb({
        project_id: PROJECT_ID,
        account_id: ACCOUNT_ID,
        fingerprint: "fp-1",
      }),
    ).toBe(true);

    const {
      rows: [afterDelete],
    } = await getPool().query(
      "SELECT users -> $2::text -> 'ssh_keys' AS ssh_keys FROM projects WHERE project_id = $1",
      [PROJECT_ID, ACCOUNT_ID],
    );
    expect(afterDelete?.ssh_keys).toBeNull();
    expect(await sshKeys(PROJECT_ID)).toEqual({});
  });
});
