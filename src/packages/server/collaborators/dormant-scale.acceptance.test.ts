/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  cleanupCandidatesSql,
  cleanupStaleSql,
} from "@cocalc/database/postgres/collaborators/collaborators-projection";
import { MultibayAcceptance } from "./acceptance/harness";
import {
  claimDemandAccountsSql,
  demandActivationCandidatesSql,
} from "@cocalc/database/postgres/collaborators/collaborators-demand";

const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1" &&
  process.env.COCALC_PEOPLE_SCALE_ACCEPTANCE === "1"
    ? describe
    : describe.skip;

acceptance("dormant population query plans (isolated PostgreSQL)", () => {
  let env: MultibayAcceptance;
  let populated = 0;
  let activeBaseline: Record<string, number> | undefined;
  let workBaseline: Record<string, number> | undefined;
  const demand = (operation: string, opts = {}) =>
    env.worker("a").call("demand", { operation, opts });
  const workCounters = async (): Promise<Record<string, number>> => {
    const metrics = await env.worker("a").call<any[]>("indexingMetrics");
    return Object.fromEntries(
      (
        metrics.find((m) => m.name === "cocalc_people_indexing_work_total")
          ?.values ?? []
      ).map((v) => [v.labels.kind, v.value]),
    );
  };
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
    await demand("install");
    await env.sql("a", "DELETE FROM collaboration_access");
  }, 240000);
  afterAll(async () => await env?.close(), 60000);

  test.each([0, 100_000, 1_000_000])(
    "%i dormant memberships do not turn cleanup into a population scan",
    async (count) => {
      // Batches keep individual fixture setup requests below the RPC deadline.
      while (populated < count) {
        const end = Math.min(populated + 10_000, count);
        await env.sql(
          "a",
          `INSERT INTO accounts(account_id,home_bay_id)
          SELECT md5('dormant-scale-' || n)::uuid,$1
          FROM generate_series($2::integer,$3::integer) n`,
          [env.bays[1], populated + 1, end],
        );
        await env.sql(
          "a",
          `INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary)
          SELECT md5('dormant-scale-' || n)::uuid,$1,$2,
          jsonb_build_object((md5('dormant-scale-' || n)::uuid)::text,jsonb_build_object('group','collaborator'))
          FROM generate_series($3::integer,$4::integer) n`,
          [env.project, env.bays[0], populated + 1, end],
        );
        await env.sql(
          "a",
          `INSERT INTO collaboration_access(account_id,project_id,due_at,lease_due_at)
          SELECT md5('dormant-scale-' || n)::uuid,$1,now()-interval '1 day',now()-interval '1 day'
          FROM generate_series($2::integer,$3::integer) n`,
          [env.project, populated + 1, end],
        );
        await env.sql(
          "a",
          `INSERT INTO collaboration_demand_activation(account_id,due_at,projection_due,access_due)
          SELECT md5('dormant-scale-' || n)::uuid,
            CASE WHEN n%2=0 THEN NULL ELSE now()+interval '1 day' END,
            CASE WHEN n%2=0 THEN NULL ELSE now()+interval '1 day' END,
            CASE WHEN n%2=0 THEN NULL ELSE now()+interval '1 day' END
          FROM generate_series($1::integer,$2::integer) n`,
          [populated + 1, end],
        );
        populated = end;
      }
      for (const table of [
        "accounts",
        "account_project_index",
        "collaboration_access",
        "collaboration_demand_activation",
      ])
        await env.sql("a", `ANALYZE ${table}`);
      const zero = "00000000-0000-0000-0000-000000000000";
      const candidates = await env.sql("a", cleanupCandidatesSql, [zero, zero]);
      for (const [name, sql, params] of [
        ["candidates", cleanupCandidatesSql, [zero, zero]],
        ["activation", demandActivationCandidatesSql, [env.bays[1]]],
        [
          "projection-claim",
          claimDemandAccountsSql("projection"),
          [env.bays[1], 8],
        ],
        ["access-claim", claimDemandAccountsSql("access"), [env.bays[1], 8]],
        ["stale", cleanupStaleSql(), [env.bays[1], JSON.stringify(candidates)]],
      ] as const) {
        const result = await env.sql(
          "a",
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
          [...params],
        );
        const explain = result[0]["QUERY PLAN"][0];
        const plan = explain.Plan;
        const blocks =
          (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0);
        // Emit machine-readable benchmark evidence from synthetic data only.
        process.stdout.write(
          JSON.stringify({
            count,
            query: name,
            blocks,
            execution_ms: explain["Execution Time"],
            plan,
          }) + "\n",
        );
        // A generous fixed I/O ceiling detects a population sweep without
        // asserting a machine-dependent wall-clock capacity promise.
        expect(blocks).toBeLessThan(2000);
      }
      const before = (await env.worker("owner").call("inspect")).counters
        .ownerCalls;
      await env.sql(
        "a",
        "DELETE FROM collaboration_maintenance WHERE id='cleanup'",
      );
      await demand("maintenance");
      await demand("maintenance");
      const after = (await env.worker("owner").call("inspect")).counters
        .ownerCalls;
      for (const method of [
        "sharedProjectPage",
        "refreshAccess",
        "notificationObligation",
      ])
        expect(after[method] ?? 0).toBe(before[method] ?? 0);
      expect(
        await env.sql(
          "a",
          "SELECT count(*)::integer AS n FROM collaboration_access WHERE grant_request_id IS NOT NULL",
        ),
      ).toEqual([{ n: 0 }]);
      expect(
        await env.sql(
          "a",
          "SELECT count(*)::integer AS n FROM collaboration_access",
        ),
      ).toEqual([{ n: count }]);

      // Identical cold-to-active request at each population size. Reset only
      // this fixture account afterwards; dormant scheduling state stays intact.
      const activeBefore = (await env.worker("owner").call("inspect")).counters
        .ownerCalls;
      const workBefore = await workCounters();
      await demand("acquire", {
        consumer_id: "00000000-0000-4000-8000-000000000001",
        scope: { kind: "projects", project_ids: [env.project] },
      });
      await demand("activationPass");
      await demand("maintenance");
      await demand("maintenance");
      const activeAfter = (await env.worker("owner").call("inspect")).counters
        .ownerCalls;
      const workAfter = await workCounters();
      const work = Object.fromEntries(
        Object.keys(workAfter)
          .sort()
          .map((kind) => [kind, workAfter[kind] - (workBefore[kind] ?? 0)]),
      );
      const operations = Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(activeBefore),
            ...Object.keys(activeAfter),
          ]),
        ]
          .sort()
          .map((method) => [
            method,
            (activeAfter[method] ?? 0) - (activeBefore[method] ?? 0),
          ]),
      );
      process.stdout.write(
        JSON.stringify({
          count,
          workload: "one-project-activation",
          operations,
          work,
        }) + "\n",
      );
      const dormantGrants = await env.sql(
        "a",
        "SELECT count(*)::integer AS n FROM collaboration_access WHERE account_id<>$1 AND grant_request_id IS NOT NULL",
        [env.accounts[0]],
      );
      for (const table of [
        "collaboration_access",
        "collaboration_index",
        "collaboration_demand",
        "collaboration_demand_activation",
        "collaboration_project_demand",
      ]) {
        await env.sql("a", `DELETE FROM ${table} WHERE account_id=$1`, [
          env.accounts[0],
        ]);
      }
      expect(dormantGrants).toEqual([{ n: 0 }]);
      expect(operations.projectPage).toBe(1);
      expect(work.projection_claimed).toBe(1);
      if (activeBaseline == null) activeBaseline = operations;
      else expect(operations).toEqual(activeBaseline);
      if (workBaseline == null) workBaseline = work;
      else expect(work).toEqual(workBaseline);
    },
    600000,
  );
  test("100000 ineligible due accounts do not turn scheduling into a population scan", async () => {
    for (let start = 1; start <= 100000; start += 10000) {
      const ids = `SELECT md5('dormant-scale-' || n)::uuid FROM generate_series($1::integer,$2::integer) n`;
      const params = [start, start + 9999];
      await env.sql(
        "a",
        `UPDATE accounts SET banned=TRUE WHERE account_id IN (${ids})`,
        params,
      );
      await env.sql(
        "a",
        `UPDATE collaboration_demand_activation
        SET due_at=now()-interval '1 day',projection_due=now()-interval '1 day',access_due=now()-interval '1 day'
        WHERE account_id IN (${ids})`,
        params,
      );
    }
    await env.sql("a", "ANALYZE accounts");
    await env.sql("a", "ANALYZE collaboration_demand_activation");
    for (const [name, sql, params] of [
      ["activation", demandActivationCandidatesSql, [env.bays[1]]],
      ["projection", claimDemandAccountsSql("projection"), [env.bays[1], 8]],
      ["access", claimDemandAccountsSql("access"), [env.bays[1], 8]],
    ] as const) {
      const rows = await env.sql(
        "a",
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
        [...params],
      );
      const explain = rows[0]["QUERY PLAN"][0];
      const blocks =
        (explain.Plan["Shared Hit Blocks"] ?? 0) +
        (explain.Plan["Shared Read Blocks"] ?? 0);
      process.stdout.write(
        JSON.stringify({
          count: 100000,
          query: `ineligible-${name}`,
          blocks,
          execution_ms: explain["Execution Time"],
          plan: explain.Plan,
        }) + "\n",
      );
      expect(blocks).toBeLessThan(2000);
      expect(explain.Plan["Actual Rows"]).toBe(name === "activation" ? 0 : 8);
    }
    expect(
      await env.sql(
        "a",
        `SELECT
      count(*) FILTER (WHERE q.due_at IS NULL)::integer AS activation,
      count(*) FILTER (WHERE q.projection_due IS NULL)::integer AS projection,
      count(*) FILTER (WHERE q.access_due IS NULL)::integer AS access
      FROM collaboration_demand_activation q JOIN accounts a USING(account_id) WHERE a.banned IS TRUE`,
      ),
    ).toEqual([{ activation: 8, projection: 8, access: 8 }]);
  }, 600000);
});
