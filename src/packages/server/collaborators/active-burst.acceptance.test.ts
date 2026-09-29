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
    await env.hub("a", "ensureRoom", {
      project_id: env.project,
      request_id: randomUUID(),
    });
    await env.send("a", "initialize", { request_id: randomUUID() });
    const resources: string[] = [];
    for (let i = 0; i < 24; i++) {
      const thread = await env.send("a", "createThread", {
        request_id: randomUUID(),
        title: `Burst conversation ${i}`,
      });
      resources.push(thread.thread_id);
    }
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
    while (Date.now() - started < 120000) {
      const [row] = await env.sql(
        "a",
        `SELECT count(*)::integer AS n FROM collaboration_access a
        WHERE account_id=ANY($1::uuid[]) AND generation IS NOT NULL AND lease_until>clock_timestamp()
        AND (SELECT count(*) FROM collaboration_index i
          WHERE i.account_id=a.account_id AND i.project_id=a.project_id
          AND i.metadata->>'resource_id'=ANY($2::text[]))=$3`,
        [accounts, resources, resources.length],
      );
      ready = row.n;
      samples.push({ elapsed_ms: Date.now() - started, ready });
      if (ready === accounts.length) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
        workload: "100-account-24-conversation-activation",
        samples,
        calls,
      }) + "\n",
    );
    if (ready !== accounts.length)
      process.stdout.write(
        JSON.stringify({
          owner: await env.sql(
            "owner",
            "SELECT count(*)::integer AS n FROM collaboration_catalog",
          ),
          home: await env.sql(
            "a",
            "SELECT count(*)::integer AS n FROM collaboration_index",
          ),
          jobs: await env.sql(
            "a",
            "SELECT * FROM collaboration_access WHERE account_id=$1",
            [accounts[0]],
          ),
        }) + "\n",
      );
    expect(ready).toBe(accounts.length);
    const updateStarted = Date.now();
    const update = await env.send("a", "createThread", {
      request_id: randomUUID(),
      title: "After activation",
    });
    let updated = 0;
    let ownerObservedMs: number | undefined;
    let firstHomeObservedMs: number | undefined;
    while (Date.now() - updateStarted < 30000) {
      if (ownerObservedMs === undefined) {
        const rows = await env.sql(
          "owner",
          "SELECT 1 FROM collaboration_catalog WHERE metadata->>'resource_id'=$1",
          [update.thread_id],
        );
        if (rows.length) ownerObservedMs = Date.now() - updateStarted;
      }
      const [row] = await env.sql(
        "a",
        `SELECT count(*)::integer AS n
        FROM collaboration_index WHERE account_id=ANY($1::uuid[])
        AND metadata->>'resource_id'=$2`,
        [accounts, update.thread_id],
      );
      updated = row.n;
      if (updated && firstHomeObservedMs === undefined)
        firstHomeObservedMs = Date.now() - updateStarted;
      if (updated === accounts.length) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.stdout.write(
      JSON.stringify({
        workload: "100-account-later-conversation",
        elapsed_ms: Date.now() - updateStarted,
        updated,
        ownerObservedMs,
        firstHomeObservedMs,
      }) + "\n",
    );
    if (updated !== accounts.length)
      process.stdout.write(
        JSON.stringify({
          ownerUpdate: await env.sql(
            "owner",
            "SELECT revision,metadata->>'resource_id' AS resource_id FROM collaboration_catalog WHERE metadata->>'resource_id'=$1",
            [update.thread_id],
          ),
          receiver: await env.sql(
            "a",
            "SELECT * FROM collaboration_revision_receivers",
          ),
          jobs: await env.sql(
            "a",
            "SELECT revision,complete,last_error,count(*)::integer AS n FROM collaboration_access GROUP BY revision,complete,last_error",
          ),
          activation: await env.sql(
            "a",
            "SELECT * FROM collaboration_demand_activation WHERE account_id=$1",
            [accounts[0]],
          ),
        }) + "\n",
      );
    expect(updated).toBe(accounts.length);
    const streamStarted = Date.now();
    const sent = new Map<string, number>();
    const completed = new Map<string, number>();
    const backlog: { elapsed_ms: number; pending_projections: number }[] = [];
    const observe = async () => {
      const rows = await env.sql(
        "a",
        `SELECT metadata->>'resource_id' AS id,
        count(*)::integer AS n FROM collaboration_index
        WHERE account_id=ANY($1::uuid[]) AND metadata->>'resource_id'=ANY($2::text[])
        GROUP BY metadata->>'resource_id'`,
        [accounts, [...sent.keys()]],
      );
      const now = Date.now();
      let applied = 0;
      for (const row of rows) {
        applied += row.n;
        if (row.n === accounts.length && !completed.has(row.id))
          completed.set(row.id, now - sent.get(row.id)!);
      }
      backlog.push({
        elapsed_ms: now - streamStarted,
        pending_projections: sent.size * accounts.length - applied,
      });
    };
    const streamBefore = (await env.worker("owner").call("inspect")).counters
      .ownerCalls;
    for (let i = 0; i < 30; i++) {
      const delay = streamStarted + i * 1000 - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const began = Date.now();
      const thread = await env.send("a", "createThread", {
        request_id: randomUUID(),
        title: `Streaming ${i}`,
      });
      sent.set(thread.thread_id, began);
      await observe();
    }
    const sendingMs = Date.now() - streamStarted;
    const drainDeadline = Date.now() + 60000;
    while (completed.size < sent.size && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await observe();
    }
    const streamAfter = (await env.worker("owner").call("inspect")).counters
      .ownerCalls;
    const latencies = [...completed.values()].sort((a, b) => a - b);
    process.stdout.write(
      JSON.stringify({
        workload: "100-account-30-conversations-one-per-second",
        sending_ms: sendingMs,
        elapsed_ms: Date.now() - streamStarted,
        completed: completed.size,
        backlog,
        all_accounts_latency_ms: latencies,
        calls: Object.fromEntries(
          Object.keys(streamAfter).map((name) => [
            name,
            streamAfter[name] - (streamBefore[name] ?? 0),
          ]),
        ),
      }) + "\n",
    );
    expect(completed.size).toBe(sent.size);
    expect(backlog.at(-1)?.pending_projections).toBe(0);
    for (const role of ["owner", "a"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 180000);
});
