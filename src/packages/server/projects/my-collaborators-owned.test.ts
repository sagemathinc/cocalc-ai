/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { listMyCollaborators } from "./collaborators";

const ME = "11111111-1111-4111-8111-111111111111";
const LOCAL_PEER = "22222222-2222-4222-8222-222222222222";
const STALE_PEER = "33333333-3333-4333-8333-333333333333";
const OWNED_HERE = "44444444-4444-4444-8444-444444444444";
const OWNED_ELSEWHERE = "55555555-5555-4555-8555-555555555555";

describe("listMyCollaborators reads only projects this bay owns", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
  }, 15000);

  afterAll(async () => {
    await getPool().end();
  });

  it("a stale local copy of another bay's project doesn't keep a removed collaborator", async () => {
    delete process.env.COCALC_ACCOUNT_COLLABORATOR_INDEX_COLLABORATOR_READS;
    const pool = getPool();
    for (const [account_id, first_name] of [
      [ME, "Me"],
      [LOCAL_PEER, "Local"],
      [STALE_PEER, "Stale"],
    ]) {
      await pool.query(
        `INSERT INTO accounts (account_id, first_name, last_name, created, email_address)
         VALUES ($1, $2, 'Peer', NOW(), $3)`,
        [account_id, first_name, `${first_name.toLowerCase()}@example.com`],
      );
    }
    const users = (peer: string) => ({
      [ME]: { group: "owner" },
      [peer]: { group: "collaborator" },
    });
    // This bay (the default, bay-0) owns one project shared with Local.
    await pool.query(
      `INSERT INTO projects (project_id, title, users, owning_bay_id)
       VALUES ($1, 'here', $2, 'bay-0')`,
      [OWNED_HERE, users(LOCAL_PEER)],
    );
    // A copy of bay-1's project, left from before: Stale was removed there,
    // and this bay's collaborator index (empty here) no longer lists them.
    await pool.query(
      `INSERT INTO projects (project_id, title, users, owning_bay_id)
       VALUES ($1, 'elsewhere', $2, 'bay-1')`,
      [OWNED_ELSEWHERE, users(STALE_PEER)],
    );

    const rows = await listMyCollaborators({ account_id: ME, limit: 20 });
    expect(rows.map((row) => row.account_id)).toEqual([LOCAL_PEER]);
    expect(rows[0].shared_projects).toBe(1);
  });
});
