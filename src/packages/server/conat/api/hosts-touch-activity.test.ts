/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { touchProject, touchProjectActivity } from "./hosts";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const HOST_A = "33333333-3333-4333-8333-333333333333";
const HOST_B = "44444444-4444-4444-8444-444444444444";
const OLD = "2026-01-01T00:00:00.000Z";

async function seed({ deleted = false } = {}) {
  await getPool().query(
    `INSERT INTO projects
       (project_id, title, users, owning_bay_id, host_id, created, last_edited, deleted)
     VALUES ($1, 'P', $2::JSONB, 'bay-0', $3, NOW(), NOW(), $4)`,
    [
      PROJECT_ID,
      JSON.stringify({ [ACCOUNT_ID]: { group: "owner" } }),
      HOST_A,
      deleted,
    ],
  );
  // touchProject creates the change-tracking columns; then pin every time.
  await touchProject({ host_id: HOST_A, project_id: PROJECT_ID });
  await getPool().query(
    `UPDATE projects
        SET last_edited=$2::timestamp, last_changed=$2::timestamp,
            last_active=jsonb_build_object($3::text, $4::text)
      WHERE project_id=$1`,
    [PROJECT_ID, OLD, ACCOUNT_ID, OLD],
  );
  await getPool().query(`DELETE FROM project_events_outbox`);
}

async function row() {
  const { rows } = await getPool().query(
    `SELECT last_edited, last_changed, last_active
       FROM projects WHERE project_id=$1`,
    [PROJECT_ID],
  );
  return rows[0];
}

async function events() {
  const { rows } = await getPool().query(
    `SELECT event_type, payload_json FROM project_events_outbox
      WHERE project_id=$1`,
    [PROJECT_ID],
  );
  return rows;
}

describe("hosts.touchProjectActivity", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterEach(async () => {
    await getPool().query(`TRUNCATE projects, project_events_outbox CASCADE`);
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("moves last_edited only: not last_changed, not last_active, and queues no event", async () => {
    await seed();
    const before = await row();
    await touchProjectActivity({ host_id: HOST_A, project_id: PROJECT_ID });
    const after = await row();
    expect(new Date(after.last_edited).valueOf()).toBeGreaterThan(
      new Date(before.last_edited).valueOf(),
    );
    expect(after.last_changed).toEqual(before.last_changed);
    expect(after.last_active).toEqual(before.last_active);
    expect(after.last_active).toEqual({ [ACCOUNT_ID]: OLD });
    expect(await events()).toEqual([]);
  });

  it("with summary, queues one summary event carrying the new last_edited", async () => {
    await seed();
    const before = await row();
    await touchProjectActivity({
      host_id: HOST_A,
      project_id: PROJECT_ID,
      summary: true,
    });
    const after = await row();
    const queued = await events();
    expect(queued.map((e) => e.event_type)).toEqual([
      "project.summary_changed",
    ]);
    const payload =
      typeof queued[0].payload_json === "string"
        ? JSON.parse(queued[0].payload_json)
        : queued[0].payload_json;
    expect(new Date(payload.last_edited_at).toISOString()).toBe(
      new Date(after.last_edited).toISOString(),
    );
    expect(after.last_changed).toEqual(before.last_changed);
  });

  it("host B cannot touch host A's project, with or without summary", async () => {
    await seed();
    const before = await row();
    await touchProjectActivity({
      host_id: HOST_B,
      project_id: PROJECT_ID,
      summary: true,
    });
    expect(await row()).toEqual(before);
    expect(await events()).toEqual([]);
  });

  it("a deleted project is not touched", async () => {
    await seed({ deleted: true });
    const before = await row();
    await touchProjectActivity({
      host_id: HOST_A,
      project_id: PROJECT_ID,
      summary: true,
    });
    expect(await row()).toEqual(before);
    expect(await events()).toEqual([]);
  });

  it("requires a host and a valid project id", async () => {
    await expect(
      touchProjectActivity({ project_id: PROJECT_ID } as any),
    ).rejects.toThrow("host_id must be specified");
    await expect(
      touchProjectActivity({ host_id: HOST_A, project_id: "nope" }),
    ).rejects.toThrow("project_id must be a valid uuid");
  });
});
