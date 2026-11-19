/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  ANTHROPIC_API_PROVIDER,
  CLAUDE_SUBSCRIPTION_KIND,
} from "@cocalc/util/ai/external-credential-profiles";
import {
  dueClaudeUsageProbes,
  runClaudeUsageProbes,
  type ClaudeUsageProbeDeps,
} from "./claude-usage-probe";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const HOUR = 3600_000;
const sec = (ms: number) => Math.round(ms / 1000);

describeDb("fresh Claude readings for Auto", () => {
  const query = (sql: string, values?: unknown[]) =>
    getPool().query(sql, values as any[]);
  let now = Date.parse("2026-11-19T20:00:00Z");

  const reading = (ageMs: number) => ({
    observed_at: new Date(now - ageMs).toISOString(),
    windows: {
      five_hour: { utilization: 0.2, resets_at: sec(now + 2 * HOUR) },
      seven_day: { utilization: 0.5, resets_at: sec(now + 72 * HOUR) },
    },
  });
  const usedAuto = (ageMs: number) => [
    { at: now - ageMs, week: 0.5, resets_at: sec(now + 72 * HOUR) },
  ];

  async function credential(
    owner: string,
    // Raw JSON text for values a JS object cannot hold (e.g. 1e10000).
    metadata: Record<string, unknown> | string,
    revoked = false,
  ): Promise<string> {
    const id = randomUUID();
    await query(
      `INSERT INTO external_credentials
         (id, provider, kind, scope, owner_account_id, encrypted_payload,
          metadata, created, updated, revoked)
       VALUES ($1,$2,$3,'account',$4,'x',$5,now(),now(),$6)`,
      [
        id,
        ANTHROPIC_API_PROVIDER,
        CLAUDE_SUBSCRIPTION_KIND,
        owner,
        metadata,
        revoked ? new Date() : null,
      ],
    );
    return id;
  }

  async function probeRecord(id: string) {
    const { rows } = await query(
      "SELECT metadata->'claude_usage_probe' AS probe FROM external_credentials WHERE id=$1",
      [id],
    );
    return rows[0]?.probe;
  }

  beforeAll(async () => {
    await syncSchema({
      external_credentials: SCHEMA.external_credentials,
      projects: SCHEMA.projects,
      project_hosts: SCHEMA.project_hosts,
    });
  });
  beforeEach(async () => {
    await query("DELETE FROM external_credentials");
    await query("DELETE FROM projects");
    await query("DELETE FROM project_hosts");
  });
  afterAll(async () => {
    await getPool().end();
  });

  test("only old readings of accounts using Auto, oldest first", async () => {
    const auto = randomUUID();
    const idle = randomUUID();
    const stale = await credential(auto, {
      claude_usage: reading(6 * HOUR),
      claude_usage_history: usedAuto(HOUR),
    });
    const staler = await credential(auto, { claude_usage: reading(30 * HOUR) });
    await credential(auto, { claude_usage: reading(HOUR) });
    await credential(auto, {
      claude_usage: reading(30 * HOUR),
      claude_pool_excluded: true,
    });
    await credential(auto, { claude_usage: reading(30 * HOUR) }, true);
    // Auto not used for over a week.
    await credential(idle, {
      claude_usage: reading(30 * HOUR),
      claude_usage_history: usedAuto(8 * 24 * HOUR),
    });
    // Older still, but its 5-hour window is full, or it is limited: the
    // database skips them, so they never take a place under the limit.
    const full = reading(40 * HOUR);
    full.windows.five_hour.utilization = 1;
    await credential(auto, { claude_usage: full });
    await credential(auto, {
      claude_usage: reading(40 * HOUR),
      claude_pool_limited: { until: new Date(now + HOUR).toISOString() },
    });
    await credential(auto, {
      claude_usage: reading(40 * HOUR),
      claude_usage_probe: { at: new Date(now - HOUR).toISOString() },
    });
    const due = await dueClaudeUsageProbes(query, now);
    expect(due.map((row) => row.id)).toEqual([staler, stale]);
    expect(
      (await dueClaudeUsageProbes(query, now, 1)).map((row) => row.id),
    ).toEqual([staler]);
  });

  const BAY = "bay-0";
  function deps(probe: ClaudeUsageProbeDeps["probe"]) {
    const calls: any[] = [];
    return {
      calls,
      deps: {
        query,
        probe: async (options) => {
          calls.push(options);
          return await probe(options);
        },
        bayId: async () => BAY,
      } satisfies ClaudeUsageProbeDeps,
    };
  }

  // A host of this bay, or of another; bay_id NULL means this bay.
  async function host(bay_id: string | null = BAY): Promise<string> {
    const id = randomUUID();
    await query("INSERT INTO project_hosts(id, bay_id) VALUES ($1,$2)", [
      id,
      bay_id,
    ]);
    return id;
  }

  async function project(
    owner: string,
    host_id: string,
    state: string,
    lastEditedAgo: number,
  ) {
    const project_id = randomUUID();
    await query(
      `INSERT INTO projects(project_id, users, host_id, state, last_edited)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        project_id,
        { [owner]: { group: "owner" } },
        host_id,
        { state },
        new Date(now - lastEditedAgo),
      ],
    );
    return project_id;
  }

  test("malformed metadata counts as missing and cannot fail the query", async () => {
    const owner = randomUUID();
    const history = JSON.stringify(usedAuto(HOUR));
    const fresh = JSON.stringify(reading(HOUR));
    // Malformed times compare above every ISO time as text; each one is
    // treated as absent, as claudeUsageProbeDue does.
    const badReading = await credential(owner, {
      claude_usage: { ...reading(HOUR), observed_at: "zzzz" },
      claude_usage_history: usedAuto(HOUR),
    });
    const badCheck = await credential(owner, {
      claude_usage: reading(6 * HOUR),
      claude_usage_probe: { at: "zzzz" },
    });
    const badLimit = await credential(owner, {
      claude_usage: reading(7 * HOUR),
      claude_pool_limited: { until: "zzzz" },
    });
    // A JSON number no float holds, in an old reading: no error, and (out
    // of range) not a full window.
    const huge = await credential(
      owner,
      `{"claude_usage": {"observed_at": "${new Date(now - 8 * HOUR).toISOString()}",
        "windows": {"five_hour": {"utilization": 1e10000, "resets_at": ${sec(now + HOUR)}},
                    "seven_day": {"utilization": 0.5, "resets_at": ${sec(now + 72 * HOUR)}}}}}`,
    );
    await credential(
      owner,
      `{"claude_usage": ${fresh}, "claude_usage_history": ${history},
        "x": {"utilization": 1e10000}}`,
    );
    const due = await dueClaudeUsageProbes(query, now);
    expect(due.map((row) => row.id).sort()).toEqual(
      [badReading, badCheck, badLimit, huge].sort(),
    );
    // A malformed reading time sorts first (as no reading).
    expect(due[0].id).toBe(badReading);
  });

  test("checks on a running project's host of this bay, once per four hours", async () => {
    const owner = randomUUID();
    const id = await credential(owner, {
      claude_usage: reading(6 * HOUR),
      claude_usage_history: usedAuto(HOUR),
    });
    const elsewhere = await host("bay-1");
    const local = await host(null);
    await project(owner, elsewhere, "running", 0);
    await project(owner, local, "opened", 0);
    const running = await project(owner, local, "running", 5 * HOUR);
    const { calls, deps: d } = deps(async () => ({
      observed_at: new Date(now).toISOString(),
    }));
    await expect(runClaudeUsageProbes(d, () => now)).resolves.toEqual({
      checked: 1,
      failed: 0,
    });
    expect(calls).toEqual([
      {
        host_id: local,
        project_id: running,
        account_id: owner,
        credential_id: id,
      },
    ]);
    expect(await probeRecord(id)).toEqual({
      at: new Date(now).toISOString(),
      ok: true,
    });
    // The reading stays old (the fake saved none), but it was just checked.
    now += HOUR;
    await runClaudeUsageProbes(d, () => now);
    expect(calls).toHaveLength(1);
    now += 3.5 * HOUR;
    await runClaudeUsageProbes(d, () => now);
    expect(calls).toHaveLength(2);
  });

  test("a failed check is recorded and not retried for four hours", async () => {
    const owner = randomUUID();
    const id = await credential(owner, {
      claude_usage_history: usedAuto(HOUR),
    });
    await project(owner, await host(), "running", 0);
    const { calls, deps: d } = deps(async () => {
      throw Error("Claude reported no limits");
    });
    await expect(runClaudeUsageProbes(d, () => now)).resolves.toEqual({
      checked: 0,
      failed: 1,
    });
    expect(await probeRecord(id)).toEqual({
      at: new Date(now).toISOString(),
      ok: false,
      error: "Claude reported no limits",
    });
    await runClaudeUsageProbes(d, () => now + HOUR);
    expect(calls).toHaveLength(1);
  });

  test("without a project on a host of this bay, nothing is called", async () => {
    const owner = randomUUID();
    const id = await credential(owner, {
      claude_usage_history: usedAuto(HOUR),
    });
    await project(owner, await host("bay-1"), "running", 0);
    // A deleted host of this bay does not count either.
    const gone = await host();
    await query("UPDATE project_hosts SET deleted=now() WHERE id=$1", [gone]);
    await project(owner, gone, "running", 0);
    const { calls, deps: d } = deps(async () => ({ observed_at: "" }));
    await runClaudeUsageProbes(d, () => now);
    expect(calls).toEqual([]);
    expect((await probeRecord(id)).error).toMatch(/no project/);
  });

  test("a local project behind newer ones on other bays' hosts is found", async () => {
    const owner = randomUUID();
    await credential(owner, { claude_usage_history: usedAuto(HOUR) });
    for (let i = 0; i < 5; i++)
      await project(owner, await host("bay-1"), "running", i * HOUR);
    const local = await host();
    const older = await project(owner, local, "opened", 30 * 24 * HOUR);
    const { calls, deps: d } = deps(async () => ({
      observed_at: new Date(now).toISOString(),
    }));
    await runClaudeUsageProbes(d, () => now);
    expect(calls.map((c) => [c.host_id, c.project_id])).toEqual([
      [local, older],
    ]);
  });

  test("at most the limit leaves the database, oldest readings first", async () => {
    const owner = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++)
      ids.push(
        await credential(owner, {
          claude_usage: reading((10 + i) * HOUR),
          claude_usage_history: usedAuto(HOUR),
        }),
      );
    const due = await dueClaudeUsageProbes(query, now, 3);
    expect(due.map((row) => row.id)).toEqual([ids[5], ids[4], ids[3]]);
  });

  test("the reading-time index serves the order", async () => {
    const { rows } = await query(
      "SELECT indexdef FROM pg_indexes WHERE indexname='external_credentials_claude_reading_at_idx'",
    );
    expect(rows[0]?.indexdef).toMatch(/claude_usage/);
    const owner = randomUUID();
    await credential(owner, { claude_usage_history: usedAuto(HOUR) });
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_sort = off");
      const plans: string[] = [];
      await dueClaudeUsageProbes(async (sql, values) => {
        const plan = await client.query(`EXPLAIN ${sql}`, values as any[]);
        plans.push(plan.rows.map((r) => r["QUERY PLAN"]).join("\n"));
        return await client.query(sql, values as any[]);
      }, now);
      expect(plans[0]).toMatch(/external_credentials_claude_reading_at_idx/);
      // Rows come in index order: no sort of the bay's subscriptions.
      expect(plans[0]).not.toMatch(/Sort/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("concurrent passes check a subscription once", async () => {
    const owner = randomUUID();
    await credential(owner, { claude_usage_history: usedAuto(HOUR) });
    await project(owner, await host(), "running", 0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calls, deps: d } = deps(async () => {
      await gate;
      return { observed_at: new Date(now).toISOString() };
    });
    const passes = [
      runClaudeUsageProbes(d, () => now),
      runClaudeUsageProbes(d, () => now),
    ];
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const results = await Promise.all(passes);
    expect(calls).toHaveLength(1);
    expect(results.map((r) => r.checked).sort()).toEqual([0, 1]);
  });
});
