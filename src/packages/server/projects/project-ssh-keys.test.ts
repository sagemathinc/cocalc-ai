/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import sshKeys from "./get-ssh-keys";
import {
  deleteProjectSshKeyInDb,
  upsertProjectSshKeyInDb,
} from "./project-ssh-keys";

jest.mock("@cocalc/server/account/project-feed", () => ({
  __esModule: true,
  publishProjectAccountFeedEventsBestEffort: jest.fn(async () => undefined),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

describe("project SSH keys", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    jest.clearAllMocks();
    await getPool().query("DELETE FROM project_events_outbox");
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
    expect(publishProjectAccountFeedEventsBestEffort).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      default_bay_id: "bay-0",
    });
    let { rows: eventRows } = await getPool().query(
      "SELECT event_type FROM project_events_outbox WHERE project_id = $1 ORDER BY created_at",
      [PROJECT_ID],
    );
    expect(eventRows).toEqual([{ event_type: "project.summary_changed" }]);

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
    expect(publishProjectAccountFeedEventsBestEffort).toHaveBeenCalledTimes(2);
    ({ rows: eventRows } = await getPool().query(
      "SELECT event_type FROM project_events_outbox WHERE project_id = $1 ORDER BY created_at",
      [PROJECT_ID],
    ));
    expect(eventRows).toEqual([
      { event_type: "project.summary_changed" },
      { event_type: "project.summary_changed" },
    ]);
  });

  it("refuses to update SSH keys for projects owned by another bay", async () => {
    await getPool().query(
      "INSERT INTO projects (project_id, title, users, last_edited, owning_bay_id) VALUES ($1, $2, $3, NOW(), $4)",
      [
        PROJECT_ID,
        "Wrong Bay Project",
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
        }),
        "bay-9",
      ],
    );

    expect(
      await upsertProjectSshKeyInDb({
        project_id: PROJECT_ID,
        account_id: ACCOUNT_ID,
        fingerprint: "fp-2",
        payload: {
          title: "laptop",
          value: "ssh-ed25519 AAAATEST laptop",
          creation_date: 123,
        },
      }),
    ).toBe(false);

    expect(
      await deleteProjectSshKeyInDb({
        project_id: PROJECT_ID,
        account_id: ACCOUNT_ID,
        fingerprint: "fp-2",
      }),
    ).toBe(false);
    expect(publishProjectAccountFeedEventsBestEffort).not.toHaveBeenCalled();
    const { rows } = await getPool().query(
      "SELECT event_type FROM project_events_outbox WHERE project_id = $1",
      [PROJECT_ID],
    );
    expect(rows).toEqual([]);
  });
});
