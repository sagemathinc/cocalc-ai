/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { MultibayAcceptance } from "./acceptance/harness";

const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;

acceptance("different-size known catalogs sharing scheduler workers", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => env?.close(), 60000);

  test("small and large projects converge for the same demanded accounts", async () => {
    const accounts = Array.from({ length: 20 }, () => randomUUID());
    const projects = [1, 8, 32, 80].map((count) => ({
      project_id: randomUUID(),
      count,
      epoch: "",
      resources: Array.from({ length: count }, (_, i) => ({
        kind: "conversation",
        resource_id: randomUUID(),
        thread_id: randomUUID(),
        title: `Initial ${i}`,
        participant_ids: [],
        participant_count: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        activity: 0,
      })),
    }));
    for (const role of ["owner", "a"] as const)
      await env.sql(
        role,
        "INSERT INTO accounts(account_id,home_bay_id) SELECT unnest($1::uuid[]),$2",
        [accounts, env.bays[1]],
      );
    const users = Object.fromEntries(
      accounts.map((id) => [id, { group: "collaborator" }]),
    );
    for (const project of projects) {
      await env.sql(
        "owner",
        "INSERT INTO projects(project_id,host_id,owning_bay_id,users,title) VALUES($1,$2,$3,$4::jsonb,'Load fixture')",
        [project.project_id, env.host, env.bays[0], JSON.stringify(users)],
      );
      await env.sql(
        "a",
        `INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary)
        SELECT id,$2,$3,jsonb_build_object(id::text,jsonb_build_object('group','collaborator'))
        FROM unnest($1::uuid[]) id`,
        [accounts, project.project_id, env.bays[0]],
      );
      // Seed known catalogs through owner store ingestion, not filesystem discovery.
      const result = await env.worker("owner").call("fixtureCatalog", {
        project_id: project.project_id,
        resources: project.resources,
        sequence: 1,
      });
      project.epoch = result.epoch;
    }
    await env.worker("a").call("demand", { operation: "install" });
    const demand = () =>
      env.worker("a").call("demand", {
        operation: "fixtureAcquireBatch",
        opts: {
          account_ids: accounts,
          project_ids: projects.map((p) => p.project_id),
        },
      });
    await demand();
    for (const role of ["owner", "a"] as const)
      await env.worker(role).call("startRevisionMaintenance");
    const observe = async (phase: string) => {
      const started = Date.now();
      const completed = new Map<string, number>();
      while (Date.now() - started < 90000) {
        const rows = await env.sql(
          "a",
          `SELECT project_id,count(*)::integer AS n
          FROM collaboration_index WHERE account_id=ANY($1::uuid[])
          AND metadata->>'title' LIKE $2 GROUP BY project_id`,
          [accounts, `${phase}%`],
        );
        for (const row of rows) {
          const project = projects.find(
            (p) => p.project_id === row.project_id,
          )!;
          if (
            row.n === project.count * accounts.length &&
            !completed.has(row.project_id)
          )
            completed.set(row.project_id, Date.now() - started);
        }
        if (completed.size === projects.length) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      process.stdout.write(
        JSON.stringify({
          workload: "four-known-projects-20-accounts",
          phase,
          projects: projects.map((p) => ({
            resources: p.count,
            complete_ms: completed.get(p.project_id) ?? null,
          })),
        }) + "\n",
      );
      expect(completed.size).toBe(projects.length);
    };
    await observe("Initial");
    await demand();
    for (const project of projects)
      await env.worker("owner").call("fixtureCatalog", {
        project_id: project.project_id,
        epoch: project.epoch,
        sequence: 2,
        resources: project.resources.map((r) => ({
          ...r,
          title: `Updated ${r.title}`,
          activity: 1,
        })),
      });
    await observe("Updated");
    expect((await env.worker("owner").call("inspect")).counters.starts).toBe(0);
  }, 240000);
});
