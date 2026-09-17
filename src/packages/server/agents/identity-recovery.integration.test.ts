/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { recoverIdentityLocal } from "./api";

jest.mock("./access", () => ({
  assertActor: async () => {},
  assertLocalAgentProject: async () => {},
  assertAgent: async () => {},
}));
jest.mock("./chat", () => ({
  withAgentChat: async (_agent, fn) => fn({}, { name: "Recovered agent" }),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("native identity recovery", () => {
  const account = randomUUID();
  const project = randomUUID();
  const oldAgent = randomUUID();
  const target = randomUUID();
  const run = randomUUID();

  beforeAll(async () => {
    process.env.COCALC_AGENT_MESSAGING_ENABLED = "1";
    const db = getPool();
    await db.query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY, users jsonb)",
    );
    await syncSchema(
      Object.fromEntries(
        [
          "agent_identities",
          "agent_identity_runs",
          "agent_personal_names",
          "agent_personal_grants",
        ].map((name) => [name, SCHEMA[name]]),
      ),
    );
    await db.query("INSERT INTO projects(project_id,users) VALUES($1,$2)", [
      project,
      { [account]: { group: "owner" } },
    ]);
    for (const [agent, thread] of [
      [oldAgent, "old-thread"],
      [target, "target-thread"],
    ])
      await db.query(
        `INSERT INTO agent_identities
         (agent_id,project_id,path,thread_id,name,created_by,disabled_at)
         VALUES($1,$2,$3,$4,'agent',$5,$6)`,
        [
          agent,
          project,
          `/home/user/${thread}.chat`,
          thread,
          account,
          agent === oldAgent ? new Date() : null,
        ],
      );
    await db.query(
      `INSERT INTO agent_identity_runs
       (agent_id,run_id,account_id,token_hash,expires_at)
       VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
      [oldAgent, run, account, randomUUID()],
    );
    await db.query(
      `INSERT INTO agent_personal_names
       (account_id,name,project_id,agent_id,metadata)
       VALUES($1,'old-name',$2,$3,'{}')`,
      [account, project, oldAgent],
    );
    await db.query(
      `INSERT INTO agent_personal_grants
       (link_id,account_id,source_project_id,source_agent_id,target_project_id,target_agent_id,direction_group_id,approval_request_id,approval,reason,generation)
       VALUES($1,$2,$3,$4,$3,$5,$6,$7,'{}','old approval',0)`,
      [
        randomUUID(),
        account,
        project,
        oldAgent,
        target,
        randomUUID(),
        randomUUID(),
      ],
    );
  });

  test("owner creates a new identity without transferring personal approvals", async () => {
    const db = getPool();
    const replacement = await recoverIdentityLocal({
      account_id: account,
      project_id: project,
      agent_id: oldAgent,
    });
    expect(replacement.agent_id).not.toBe(oldAgent);
    expect(replacement).toMatchObject({
      project_id: project,
      path: "/home/user/old-thread.chat",
      thread_id: "old-thread",
      name: "Recovered agent",
      created_by: account,
    });
    expect(
      (
        await db.query(
          "SELECT replaced_by FROM agent_identities WHERE agent_id=$1",
          [oldAgent],
        )
      ).rows[0].replaced_by,
    ).toBe(replacement.agent_id);
    expect(
      (
        await db.query(
          "SELECT ended_at FROM agent_identity_runs WHERE agent_id=$1 AND run_id=$2",
          [oldAgent, run],
        )
      ).rows[0].ended_at,
    ).toBeTruthy();
    expect(
      (await db.query("SELECT agent_id FROM agent_personal_names")).rows[0]
        .agent_id,
    ).toBe(oldAgent);
    expect(
      (await db.query("SELECT source_agent_id FROM agent_personal_grants"))
        .rows[0].source_agent_id,
    ).toBe(oldAgent);
  });
});
