/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { MultibayAcceptance } from "./acceptance/harness";

const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;

acceptance("People indexing baseline (isolated PostgreSQL)", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => await env?.close(), 60000);

  test("unchanged views still fetch owner pages on subsequent due passes", async () => {
    await env.worker("a").call("tick");
    const before = await env.worker("owner").call("inspect");
    await env.worker("a").call("tick");
    const after = await env.worker("owner").call("inspect");
    expect(after.counters.ownerCalls.projectPage).toBeGreaterThan(
      before.counters.ownerCalls.projectPage,
    );
    const metrics = await env.worker("a").call<any[]>("indexingMetrics");
    const pages = metrics.find(
      (metric) => metric.name === "cocalc_people_indexing_pages_total",
    );
    expect(
      pages.values.some(
        (value: any) => value.labels.outcome === "empty" && value.value >= 2,
      ),
    ).toBe(true);
    expect(
      JSON.stringify(
        metrics.filter((metric) =>
          metric.name.startsWith("cocalc_people_indexing_"),
        ),
      ),
    ).not.toContain(env.accounts[0]);
  }, 60000);

  test("dormant memberships are enumerated again without any user request", async () => {
    // This is deliberately a characterization test, not the desired policy.
    // Deterministic fixture IDs do not overlap the harness's random accounts.
    const count = 1000;
    await env.sql("a", "DELETE FROM collaboration_maintenance WHERE id='seed'");
    await env.sql(
      "a",
      `INSERT INTO accounts(account_id,home_bay_id)
      SELECT md5('indexing-baseline-' || n)::uuid, $1
      FROM generate_series(1,$2::integer) n`,
      [env.bays[1], count],
    );
    await env.sql(
      "a",
      `INSERT INTO account_project_index
      (account_id,project_id,owning_bay_id,users_summary,title,sort_key)
      SELECT account_id,$1,$2,
        jsonb_build_object(account_id::text,jsonb_build_object('group','collaborator')),
        'Dormant fixture',now()
      FROM accounts WHERE home_bay_id=$3 AND account_id<>$4`,
      [env.project, env.bays[0], env.bays[1], env.accounts[0]],
    );
    const rounds: number[] = [];
    for (let round = 0; round < 2; round++) {
      let enumerated = 0;
      for (let page = 0; page < 3; page++)
        enumerated += await env.worker("a").call<number>("indexingSeed");
      rounds.push(enumerated);
    }
    expect(rounds).toEqual([1001, 1001]);
    const rows = await env.sql(
      "a",
      `SELECT count(*)::integer AS n
      FROM collaboration_access`,
    );
    expect(rows[0].n).toBe(count + 1);
    // Seeding alone creates immediately eligible recurring work for all of them.
    const due = await env.sql(
      "a",
      `SELECT count(*)::integer AS n
      FROM collaboration_access WHERE due_at<=now()`,
    );
    // The harness's active account may still be on its 20-second timer.
    expect(due[0].n).toBeGreaterThanOrEqual(count);
  }, 60000);
});
