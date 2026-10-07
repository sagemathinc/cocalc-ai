/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  remoteFeedBackoffMs,
  runProjectFeedRemotePass,
} from "./project-feed-remote-maintenance";

const forwardRemoteProjectFeedEvents = jest.fn();
const previousVisibleAccountIdsBefore = jest.fn();

jest.mock("@cocalc/server/account/project-feed", () => ({
  ...jest.requireActual("@cocalc/server/account/project-feed"),
  forwardRemoteProjectFeedEvents: (...args: any[]) =>
    forwardRemoteProjectFeedEvents(...args),
  previousVisibleAccountIdsBefore: (...args: any[]) =>
    previousVisibleAccountIdsBefore(...args),
}));

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "33333333-3333-4333-8333-333333333333";
const CAROL = "55555555-5555-4555-8555-555555555555";

let seq = 0;

async function appendEvent(opts: {
  project_id?: string;
  users: Record<string, { group: string }>;
  title: string;
  pending?: boolean;
}): Promise<string> {
  seq += 1;
  const { rows } = await getPool().query<{ event_id: string }>(
    `INSERT INTO project_events_outbox
       (event_id, project_id, owning_bay_id, event_type, payload_json,
        created_at, remote_feed_pending)
     VALUES (gen_random_uuid(), $1, 'bay-0', 'project.membership_changed', $2,
             NOW() - ($3::INT * INTERVAL '1 second'), $4)
     RETURNING event_id`,
    [
      opts.project_id ?? PROJECT_ID,
      {
        project_id: opts.project_id ?? PROJECT_ID,
        title: opts.title,
        users_summary: opts.users,
      },
      // Older events are created further in the past.
      1000 - seq,
      opts.pending ?? true,
    ],
  );
  return rows[0].event_id;
}

async function outboxRows() {
  const { rows } = await getPool().query(
    `SELECT event_id, project_id, remote_feed_pending, remote_feed_published_at,
            remote_feed_attempts, remote_feed_next_attempt_at, remote_feed_last_error
       FROM project_events_outbox
      ORDER BY created_at`,
  );
  return rows;
}

describe("runProjectFeedRemotePass", () => {
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
    await getPool().query("TRUNCATE project_events_outbox");
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("forwards a pending event and marks it published", async () => {
    await appendEvent({ users: { [ALICE]: { group: "owner" } }, title: "A" });

    const result = await runProjectFeedRemotePass({ bay_id: "bay-0" });

    expect(result).toMatchObject({
      projects: 1,
      forwarded_projects: 1,
      failed_projects: 0,
      events: 1,
    });
    expect(forwardRemoteProjectFeedEvents).toHaveBeenCalledTimes(1);
    expect(forwardRemoteProjectFeedEvents.mock.calls[0][0]).toMatchObject({
      bay_id: "bay-0",
      payload: { title: "A" },
      previousVisibleAccountIds: [],
    });
    const [row] = await outboxRows();
    expect(row).toMatchObject({
      remote_feed_pending: false,
      remote_feed_next_attempt_at: null,
      remote_feed_last_error: null,
    });
    expect(row.remote_feed_published_at).toBeInstanceOf(Date);

    // Nothing left to do.
    await expect(
      runProjectFeedRemotePass({ bay_id: "bay-0" }),
    ).resolves.toMatchObject({ projects: 0 });
    expect(forwardRemoteProjectFeedEvents).toHaveBeenCalledTimes(1);
  });

  it("ignores events that were never marked for remote delivery", async () => {
    await appendEvent({
      users: { [ALICE]: { group: "owner" } },
      title: "single-bay",
      pending: false,
    });
    await expect(
      runProjectFeedRemotePass({ bay_id: "bay-0" }),
    ).resolves.toMatchObject({ projects: 0 });
    expect(forwardRemoteProjectFeedEvents).not.toHaveBeenCalled();
  });

  it("keeps a failed event pending with backoff and the error", async () => {
    await appendEvent({ users: { [ALICE]: { group: "owner" } }, title: "A" });
    forwardRemoteProjectFeedEvents.mockRejectedValueOnce(
      new Error("account-directory timeout"),
    );

    const failed = await runProjectFeedRemotePass({ bay_id: "bay-0" });
    expect(failed).toMatchObject({ projects: 1, failed_projects: 1 });

    const [row] = await outboxRows();
    expect(row).toMatchObject({
      remote_feed_pending: true,
      remote_feed_attempts: 1,
      remote_feed_published_at: null,
    });
    expect(row.remote_feed_last_error).toContain("account-directory timeout");
    expect(row.remote_feed_next_attempt_at.getTime()).toBeGreaterThan(
      Date.now(),
    );

    // Still backing off: not retried yet.
    await expect(
      runProjectFeedRemotePass({ bay_id: "bay-0" }),
    ).resolves.toMatchObject({ projects: 0 });
    expect(forwardRemoteProjectFeedEvents).toHaveBeenCalledTimes(1);

    // Once due, the retry succeeds and clears the error.
    await getPool().query(
      "UPDATE project_events_outbox SET remote_feed_next_attempt_at = NOW() - INTERVAL '1 second'",
    );
    await expect(
      runProjectFeedRemotePass({ bay_id: "bay-0" }),
    ).resolves.toMatchObject({ forwarded_projects: 1 });
    const [after] = await outboxRows();
    expect(after).toMatchObject({
      remote_feed_pending: false,
      remote_feed_last_error: null,
    });
  });

  it("forwards a project's pending events together as the newest snapshot", async () => {
    previousVisibleAccountIdsBefore.mockResolvedValue([ALICE]);
    await appendEvent({
      users: { [ALICE]: { group: "owner" }, [BOB]: { group: "collaborator" } },
      title: "first",
    });
    await appendEvent({
      users: {
        [ALICE]: { group: "owner" },
        [CAROL]: { group: "collaborator" },
      },
      title: "second",
    });
    await appendEvent({
      users: { [ALICE]: { group: "owner" } },
      title: "third",
    });

    const result = await runProjectFeedRemotePass({ bay_id: "bay-0" });

    expect(result).toMatchObject({ projects: 1, events: 3 });
    expect(forwardRemoteProjectFeedEvents).toHaveBeenCalledTimes(1);
    const call = forwardRemoteProjectFeedEvents.mock.calls[0][0];
    expect(call.payload.title).toBe("third");
    // Bob and Carol could see intermediate states, so they must hear that
    // they lost the project.
    expect([...call.previousVisibleAccountIds].sort()).toEqual(
      [ALICE, BOB, CAROL].sort(),
    );
    // The baseline is taken before the oldest pending event.
    const oldest = (await outboxRows())[0];
    expect(
      previousVisibleAccountIdsBefore.mock.calls[0][0].event.event_id,
    ).toBe(oldest.event_id);
    expect(
      (await outboxRows()).every((row) => row.remote_feed_pending === false),
    ).toBe(true);
  });

  it("does not let a newer event overtake an event that is backing off", async () => {
    await appendEvent({ users: { [ALICE]: { group: "owner" } }, title: "A" });
    forwardRemoteProjectFeedEvents.mockRejectedValueOnce(new Error("down"));
    await runProjectFeedRemotePass({ bay_id: "bay-0" });

    await appendEvent({ users: { [ALICE]: { group: "owner" } }, title: "B" });
    await expect(
      runProjectFeedRemotePass({ bay_id: "bay-0" }),
    ).resolves.toMatchObject({ projects: 0 });
    expect(forwardRemoteProjectFeedEvents).toHaveBeenCalledTimes(1);

    await getPool().query(
      "UPDATE project_events_outbox SET remote_feed_next_attempt_at = NOW() - INTERVAL '1 second' WHERE remote_feed_next_attempt_at IS NOT NULL",
    );
    await expect(
      runProjectFeedRemotePass({ bay_id: "bay-0" }),
    ).resolves.toMatchObject({ projects: 1, events: 2 });
    expect(forwardRemoteProjectFeedEvents.mock.calls[1][0].payload.title).toBe(
      "B",
    );
  });

  it("does not claim a project another process has leased", async () => {
    await appendEvent({ users: { [ALICE]: { group: "owner" } }, title: "A" });
    await getPool().query(
      "UPDATE project_events_outbox SET remote_feed_next_attempt_at = NOW() + INTERVAL '5 minutes'",
    );
    await appendEvent({ users: { [ALICE]: { group: "owner" } }, title: "B" });
    await appendEvent({
      project_id: OTHER_PROJECT_ID,
      users: { [ALICE]: { group: "owner" } },
      title: "other",
    });

    const result = await runProjectFeedRemotePass({ bay_id: "bay-0" });

    expect(result).toMatchObject({ projects: 1, forwarded_projects: 1 });
    expect(forwardRemoteProjectFeedEvents).toHaveBeenCalledTimes(1);
    expect(forwardRemoteProjectFeedEvents.mock.calls[0][0].payload.title).toBe(
      "other",
    );
  });

  it("caps backoff", () => {
    expect(remoteFeedBackoffMs(0)).toBe(2_000);
    expect(remoteFeedBackoffMs(1)).toBe(4_000);
    expect(remoteFeedBackoffMs(100)).toBe(5 * 60_000);
  });
});
