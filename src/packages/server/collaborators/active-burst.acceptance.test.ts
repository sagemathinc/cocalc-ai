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

acceptance("synthetic active-account scheduler burst", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => env?.close(), 60000);

  test("100 demanded accounts converge over the owner fabric", async () => {
    const accounts = Array.from({ length: 100 }, () => randomUUID());
    for (const role of ["owner", "a"] as const)
      await env.sql(
        role,
        "INSERT INTO accounts(account_id,home_bay_id) SELECT unnest($1::uuid[]),$2",
        [accounts, env.bays[1]],
      );
    const users = Object.fromEntries(
      accounts.map((id) => [id, { group: "collaborator" }]),
    );
    await env.sql(
      "owner",
      "UPDATE projects SET users=users || $2::jsonb WHERE project_id=$1",
      [env.project, JSON.stringify(users)],
    );
    await env.sql(
      "a",
      `INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary)
      SELECT id,$2,$3,jsonb_build_object(id::text,jsonb_build_object('group','collaborator'))
      FROM unnest($1::uuid[]) id`,
      [accounts, env.project, env.bays[0]],
    );
    // These are trusted fixture store calls, not simulated browser identities.
    await env.worker("a").call("demand", { operation: "install" });
    await env.worker("a").call("demand", {
      operation: "fixtureAcquireBatch",
      opts: { account_ids: accounts },
    });
    const before = (await env.worker("owner").call("inspect")).counters
      .ownerCalls;
    const started = Date.now();
    for (const role of ["owner", "a"] as const)
      await env.worker(role).call("startRevisionMaintenance");
    let ready = 0;
    const samples: { elapsed_ms: number; ready: number }[] = [];
    while (Date.now() - started < 30000) {
      const [row] = await env.sql(
        "a",
        `SELECT count(*)::integer AS n FROM collaboration_access
        WHERE account_id=ANY($1::uuid[]) AND generation IS NOT NULL AND lease_until>clock_timestamp()`,
        [accounts],
      );
      ready = row.n;
      samples.push({ elapsed_ms: Date.now() - started, ready });
      if (ready === accounts.length) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const after = (await env.worker("owner").call("inspect")).counters
      .ownerCalls;
    const calls = Object.fromEntries(
      Object.keys(after).map((name) => [
        name,
        after[name] - (before[name] ?? 0),
      ]),
    );
    process.stdout.write(
      JSON.stringify({
        workload: "100-account-one-project-activation",
        samples,
        calls,
      }) + "\n",
    );
    expect(ready).toBe(accounts.length);
    for (const role of ["owner", "a"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 90000);
});
