/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { agentStore, MAX_LIVE_RUNS_PER_AGENT } from "./store";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("agent run capacity", () => {
  const account = randomUUID();
  const project = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    await getPool().query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY, users jsonb)",
    );
    await syncSchema(
      Object.fromEntries(
        ["agent_identities", "agent_identity_runs"].map((name) => [
          name,
          SCHEMA[name],
        ]),
      ),
    );
    await getPool().query(
      "INSERT INTO projects(project_id,users) VALUES($1,$2)",
      [project, { [account]: { group: "owner" } }],
    );
    await getPool().query(
      `INSERT INTO agent_identities
       (agent_id,project_id,path,thread_id,name,created_by)
       VALUES($1,$2,'/home/user/busy.chat','busy-thread','busy',$3)`,
      [agentId, project, account],
    );
  });

  const agent = async () =>
    (
      await getPool().query(
        "SELECT * FROM agent_identities WHERE agent_id=$1",
        [agentId],
      )
    ).rows[0];

  const addRuns = async (count: number, state: "ended" | "expired" | "live") =>
    await getPool().query(
      `INSERT INTO agent_identity_runs
       (agent_id,run_id,account_id,token_hash,expires_at,ended_at,thread_id)
       SELECT $1, gen_random_uuid(), $2, md5(random()::text || g),
         CASE WHEN $3='live' THEN now()+interval '10 minutes'
              ELSE now()-interval '1 minute' END,
         CASE WHEN $3='ended' THEN now()-interval '1 minute' END,
         'busy-thread'
       FROM generate_series(1,$4) g`,
      [agentId, account, state, count],
    );

  beforeEach(async () => {
    await getPool().query("DELETE FROM agent_identity_runs WHERE agent_id=$1", [
      agentId,
    ]);
  });

  const insertRun = async (
    runId: string,
    { ended, expired }: { ended: boolean; expired: boolean },
  ) =>
    await getPool().query(
      `INSERT INTO agent_identity_runs
       (agent_id,run_id,account_id,token_hash,expires_at,ended_at,thread_id)
       VALUES($1,$2,$3,md5(random()::text),
         CASE WHEN $4 THEN now()-interval '1 minute'
              ELSE now()+interval '10 minutes' END,
         CASE WHEN $5 THEN now()-interval '1 minute' END,'busy-thread')`,
      [agentId, runId, account, expired, ended],
    );

  test("a busy agent's ended and expired runs do not block new runs", async () => {
    // A day or two of work for an agent that starts thousands of turns.
    await addRuns(MAX_LIVE_RUNS_PER_AGENT, "ended");
    await addRuns(100, "expired");
    const issued = await agentStore().issue(
      await agent(),
      randomUUID(),
      account,
    );
    expect(issued.token).toBeTruthy();
  });

  test("the limit bounds concurrent live runs exactly", async () => {
    await addRuns(MAX_LIVE_RUNS_PER_AGENT - 1, "live");
    await agentStore().issue(await agent(), randomUUID(), account);
    await expect(
      agentStore().issue(await agent(), randomUUID(), account),
    ).rejects.toThrow("agent_identity_run_capacity");
  });

  test("retrying a recovery revives an expired replacement only if there is room", async () => {
    const original = randomUUID();
    const replacement = randomUUID();
    await insertRun(original, { ended: true, expired: true });
    await insertRun(replacement, { ended: false, expired: true });
    await addRuns(MAX_LIVE_RUNS_PER_AGENT, "live");
    await expect(
      agentStore().issue(await agent(), replacement, account, original),
    ).rejects.toThrow("agent_identity_run_capacity");
  });

  test("retrying a recovery still renews a live replacement at capacity", async () => {
    const original = randomUUID();
    const replacement = randomUUID();
    await insertRun(original, { ended: true, expired: true });
    await insertRun(replacement, { ended: false, expired: false });
    await addRuns(MAX_LIVE_RUNS_PER_AGENT - 1, "live");
    const renewed = await agentStore().issue(
      await agent(),
      replacement,
      account,
      original,
    );
    expect(renewed.run_id).toBe(replacement);
  });
});
