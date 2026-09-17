/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { cleanupAgentMessagingHistory } from "./maintenance";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("agent messaging retention", () => {
  const project = randomUUID();
  const account = randomUUID();
  const source = randomUUID();
  const target = randomUUID();
  const old = "now()-interval '200 days'";

  beforeAll(async () => {
    const db = getPool();
    await db.query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY)",
    );
    const names = [
      "agent_rpc_links",
      "agent_rpc_admission_state",
      "agent_message_project_fences",
      "agent_identities",
      "agent_identity_runs",
      "agent_message_grants",
      "agent_message_inbox",
      "agent_personal_controls",
      "agent_personal_names",
      "agent_personal_grants",
      "agent_personal_requests",
      "agent_external_identities",
      "agent_external_installations",
    ];
    await syncSchema(
      Object.fromEntries(names.map((name) => [name, SCHEMA[name]])),
    );
    await db.query("INSERT INTO projects(project_id) VALUES($1)", [project]);
    for (const agent of [source, target])
      await db.query(
        `INSERT INTO agent_identities
         (agent_id,project_id,path,thread_id,name,created_by,created_at)
         VALUES($1,$2,$3,$4,'retained',$5,${old})`,
        [agent, project, `/home/user/${agent}.chat`, agent, account],
      );
  });

  test("removes bounded terminal history without erasing uncertain work or tombstones", async () => {
    const db = getPool();
    const run = randomUUID();
    const request = randomUUID();
    const alias = randomUUID();
    const personalGrant = randomUUID();
    const rpcLink = randomUUID();
    const external = randomUUID();
    const installation = randomUUID();
    const uncertainGrant = randomUUID();
    const orphanGrant = randomUUID();
    await db.query(
      `INSERT INTO agent_identity_runs
       (agent_id,run_id,account_id,token_hash,issued_at,expires_at,ended_at)
       VALUES($1,$2,$3,$4,${old},${old},${old})`,
      [source, run, account, randomUUID()],
    );
    await db.query(
      `INSERT INTO agent_rpc_admission_state
       (token_id,kind,binding_hash,host_id,project_id,account_id,created_at,expires_at)
       VALUES($1,'permit','hash',$2,$3,$4,${old},${old})`,
      [randomUUID(), randomUUID(), project, account],
    );
    await db.query(
      `INSERT INTO agent_personal_controls(account_id,generation)
       VALUES($1,1)`,
      [account],
    );
    await db.query(
      `INSERT INTO agent_personal_names
       (account_id,name,project_id,agent_id,metadata,retired_at,created_at,updated_at)
       VALUES($1,'retained-name',$2,$3,'{}',${old},${old},${old})`,
      [account, project, source],
    );
    await db.query(
      `INSERT INTO agent_personal_requests
       (request_id,account_id,source_project_id,source_agent_id,run_id,request,state,created_at,expires_at,generation)
       VALUES($1,$2,$3,$4,$5,'{}','denied',${old},${old},0)`,
      [request, account, project, source, randomUUID()],
    );
    await db.query(
      `INSERT INTO agent_personal_requests
       (request_id,canonical_request_id,account_id,source_project_id,source_agent_id,run_id,request,state,created_at,expires_at,generation)
       VALUES($1,$2,$3,$4,$5,$6,'{}','denied',${old},${old},0)`,
      [alias, request, account, project, source, randomUUID()],
    );
    await db.query(
      `INSERT INTO agent_personal_grants
       (link_id,account_id,source_project_id,source_agent_id,target_project_id,target_agent_id,direction_group_id,approval_request_id,approval,reason,generation,created_at,expires_at,revoked_at)
       VALUES($1,$2,$3,$4,$3,$5,$6,$7,'{}','old',0,${old},${old},${old})`,
      [
        personalGrant,
        account,
        project,
        source,
        target,
        randomUUID(),
        randomUUID(),
      ],
    );
    await db.query(
      `INSERT INTO agent_rpc_links
       (link_id,source_agent_id,target_agent_id,target_project_id,approved_by,reason,created_at,expires_at,revoked_at)
       VALUES($1,$2,$3,$4,$5,'old',${old},${old},${old})`,
      [rpcLink, source, target, project, account],
    );
    await db.query(
      `INSERT INTO agent_external_identities(agent_id,account_id,label,created_at)
       VALUES($1,$2,'retained external',${old})`,
      [external, account],
    );
    await db.query(
      `INSERT INTO agent_external_installations
       (installation_id,account_id,agent_id,label,secret_hash,state,generation,approval,destinations,created_at,expires_at)
       VALUES($1,$2,$3,'old',$4,'revoked',0,'{}','[]',${old},${old})`,
      [installation, account, external, "a".repeat(64)],
    );
    for (const grant of [uncertainGrant, orphanGrant])
      await db.query(
        `INSERT INTO agent_message_grants
         (grant_id,source_agent_id,target_agent_id,approved_by,reason,created_at,expires_at,revoked_at)
         VALUES($1,$2,$3,$4,'old',${old},${old},${old})`,
        [grant, source, target, account],
      );
    await db.query(
      `INSERT INTO agent_message_inbox
       (message_id,request_id,source_agent_id,source_run_id,target_agent_id,grant_id,body,guidance,state,created_at,updated_at)
       VALUES($1,$1,$2,$3,$4,$5,'uncertain',false,'unconfirmed',${old},${old})`,
      [randomUUID(), source, randomUUID(), target, uncertainGrant],
    );

    await cleanupAgentMessagingHistory();

    for (const table of [
      "agent_identity_runs",
      "agent_rpc_admission_state",
      "agent_personal_requests",
      "agent_personal_grants",
      "agent_rpc_links",
      "agent_external_installations",
    ])
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
    expect(
      (await db.query("SELECT * FROM agent_personal_names")).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("SELECT * FROM agent_external_identities")).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("SELECT * FROM agent_identities")).rows,
    ).toHaveLength(2);
    expect(
      (await db.query("SELECT * FROM agent_message_inbox")).rows,
    ).toHaveLength(1);
    expect((await db.query("SELECT * FROM agent_message_grants")).rows).toEqual(
      [expect.objectContaining({ grant_id: uncertainGrant })],
    );
  });
});
