/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  appendProjectOutboxEventForProject,
  loadProjectOutboxPayload,
} from "./project-events-outbox";

const LOCAL_BAY_ID = "bay-local";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const HOST_ID = "33333333-3333-4333-8333-333333333333";

describe("project events outbox", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(
      "TRUNCATE project_events_outbox, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await testCleanup();
  });

  it("loads a project snapshot payload and appends it to the outbox", async () => {
    await getPool().query(
      `INSERT INTO accounts
         (account_id, first_name, last_name, created, email_address, home_bay_id)
       VALUES
         ($1, 'Test', 'User', NOW(), 'test-user@example.com', $2)`,
      [ACCOUNT_ID, LOCAL_BAY_ID],
    );
    await getPool().query(
      `INSERT INTO projects
        (project_id, title, description, users, state, host_id, owning_bay_id,
         created, last_edited, last_active)
       VALUES
        ($1, 'Phase 2 Project', 'seeded for projector',
         $2::JSONB, $3::JSONB, $4, $5, NOW(), NOW(), $6::JSONB)`,
      [
        PROJECT_ID,
        JSON.stringify({
          [ACCOUNT_ID]: { group: "owner" },
        }),
        JSON.stringify({ state: "running" }),
        HOST_ID,
        LOCAL_BAY_ID,
        JSON.stringify({
          [ACCOUNT_ID]: "2026-04-03T23:00:00.000Z",
        }),
      ],
    );

    await expect(
      loadProjectOutboxPayload({
        project_id: PROJECT_ID,
        default_bay_id: LOCAL_BAY_ID,
      }),
    ).resolves.toMatchObject({
      project_id: PROJECT_ID,
      owning_bay_id: LOCAL_BAY_ID,
      host_id: HOST_ID,
      title: "Phase 2 Project",
      description: "seeded for projector",
      users_summary: {
        [ACCOUNT_ID]: { group: "owner" },
      },
      state_summary: { state: "running" },
      deleted: false,
    });

    const event_id = await appendProjectOutboxEventForProject({
      event_type: "project.created",
      project_id: PROJECT_ID,
      default_bay_id: LOCAL_BAY_ID,
    });
    expect(event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const { rows } = await getPool().query(
      `SELECT project_id, owning_bay_id, event_type, payload_json, published_at
         FROM project_events_outbox
        WHERE event_id = $1`,
      [event_id],
    );
    expect(rows).toEqual([
      {
        project_id: PROJECT_ID,
        owning_bay_id: LOCAL_BAY_ID,
        event_type: "project.created",
        payload_json: expect.objectContaining({
          project_id: PROJECT_ID,
          owning_bay_id: LOCAL_BAY_ID,
          host_id: HOST_ID,
          title: "Phase 2 Project",
          description: "seeded for projector",
          users_summary: {
            [ACCOUNT_ID]: { group: "owner" },
          },
          state_summary: { state: "running" },
          deleted: false,
        }),
        published_at: null,
      },
    ]);
  });
});
