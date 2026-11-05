/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A running agent turn's activity touch reaches collaborators' project lists:
// the home bay's account_project_index (projected from the outbox), and other
// bays through project-feed-remote, both carrying the new last_edited.

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { drainAccountProjectIndexProjection } from "@cocalc/database/postgres/account-project-index-projector";
import {
  appendProjectOutboxEventForProject,
  setProjectOutboxRemoteFeedEnabled,
} from "@cocalc/database/postgres/project-events-outbox";
import { runProjectFeedRemotePass } from "@cocalc/server/projections/project-feed-remote-maintenance";
import { touchProjectActivity } from "./hosts";

const forwardRemoteProjectFeedEvents = jest.fn();
const previousVisibleAccountIdsBefore = jest.fn();

jest.mock("@cocalc/server/account/project-feed", () => ({
  ...jest.requireActual("@cocalc/server/account/project-feed"),
  forwardRemoteProjectFeedEvents: (...args: any[]) =>
    forwardRemoteProjectFeedEvents(...args),
  previousVisibleAccountIdsBefore: (...args: any[]) =>
    previousVisibleAccountIdsBefore(...args),
}));

const BAY = "bay-0";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const HOST_ID = "33333333-3333-4333-8333-333333333333";
const OLD = new Date("2026-01-01T00:00:00.000Z");

async function seed() {
  await getPool().query(
    `INSERT INTO accounts
       (account_id, first_name, last_name, created, email_address, home_bay_id)
     VALUES ($1, 'A', 'B', NOW(), 'a@example.com', $2)`,
    [ACCOUNT_ID, BAY],
  );
  await getPool().query(
    `INSERT INTO projects
       (project_id, title, users, state, host_id, owning_bay_id, created, last_edited)
     VALUES ($1, 'P', $2::JSONB, '{"state":"running"}'::JSONB, $3, $4, $5, $5)`,
    [
      PROJECT_ID,
      JSON.stringify({ [ACCOUNT_ID]: { group: "owner" } }),
      HOST_ID,
      BAY,
      OLD,
    ],
  );
  await appendProjectOutboxEventForProject({
    event_type: "project.created",
    project_id: PROJECT_ID,
    default_bay_id: BAY,
  });
  await drainAccountProjectIndexProjection({
    bay_id: BAY,
    limit: 10,
    dry_run: false,
  });
}

async function projectLastEdited(): Promise<number> {
  const { rows } = await getPool().query(
    "SELECT last_edited FROM projects WHERE project_id=$1",
    [PROJECT_ID],
  );
  return new Date(rows[0].last_edited).valueOf();
}

async function indexLastEdited(): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT last_edited FROM account_project_index
      WHERE account_id=$1 AND project_id=$2`,
    [ACCOUNT_ID, PROJECT_ID],
  );
  return new Date(rows[0].last_edited).valueOf();
}

describe("touchProjectActivity → project lists", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  beforeEach(() => {
    forwardRemoteProjectFeedEvents.mockReset();
    forwardRemoteProjectFeedEvents.mockResolvedValue(undefined);
    previousVisibleAccountIdsBefore.mockReset();
    previousVisibleAccountIdsBefore.mockResolvedValue([]);
  });

  afterEach(async () => {
    setProjectOutboxRemoteFeedEnabled(false);
    await getPool().query(
      "TRUNCATE account_project_index, project_events_outbox, projects, accounts CASCADE",
    );
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("the home bay's account_project_index gets the new last_edited", async () => {
    await seed();
    expect(await indexLastEdited()).toBe(OLD.valueOf());
    await touchProjectActivity({
      host_id: HOST_ID,
      project_id: PROJECT_ID,
      summary: true,
    });
    await drainAccountProjectIndexProjection({
      bay_id: BAY,
      limit: 10,
      dry_run: false,
    });
    const edited = await projectLastEdited();
    expect(edited).toBeGreaterThan(OLD.valueOf());
    expect(await indexLastEdited()).toBe(edited);
  });

  it("without summary, the index is not touched (and no event is queued)", async () => {
    await seed();
    await touchProjectActivity({ host_id: HOST_ID, project_id: PROJECT_ID });
    await drainAccountProjectIndexProjection({
      bay_id: BAY,
      limit: 10,
      dry_run: false,
    });
    expect(await projectLastEdited()).toBeGreaterThan(OLD.valueOf());
    expect(await indexLastEdited()).toBe(OLD.valueOf());
  });

  it("other bays get it through project-feed-remote", async () => {
    await seed();
    setProjectOutboxRemoteFeedEnabled(true);
    await touchProjectActivity({
      host_id: HOST_ID,
      project_id: PROJECT_ID,
      summary: true,
    });
    await runProjectFeedRemotePass({ bay_id: BAY });
    expect(forwardRemoteProjectFeedEvents).toHaveBeenCalledTimes(1);
    const { payload } = forwardRemoteProjectFeedEvents.mock.calls[0][0];
    expect(payload.project_id).toBe(PROJECT_ID);
    expect(new Date(payload.last_edited_at).valueOf()).toBe(
      await projectLastEdited(),
    );
  });
});
