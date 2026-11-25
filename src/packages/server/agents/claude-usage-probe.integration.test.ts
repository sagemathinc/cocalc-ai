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
import { claudeUsageProbeDue } from "@cocalc/util/ai/claude-usage-probe";
import {
  dueClaudeUsageProbeRows,
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
    // The owner turned the checks on, unless a test says otherwise.
    await query(
      `INSERT INTO accounts (account_id, other_settings) VALUES ($1,$2)
       ON CONFLICT (account_id) DO NOTHING`,
      [owner, { claude_usage_refresh: true }],
    );
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
      accounts: SCHEMA.accounts,
      external_credentials: SCHEMA.external_credentials,
      projects: SCHEMA.projects,
      project_hosts: SCHEMA.project_hosts,
    });
  });
  beforeEach(async () => {
    await query("DELETE FROM external_credentials");
    await query("DELETE FROM accounts");
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

  test("off unless the owner turned it on: no check, no record", async () => {
    const settings: [string, unknown][] = [
      ["never set", {}],
      ["off", { claude_usage_refresh: false }],
      ["not exactly true", { claude_usage_refresh: "true" }],
      ["no settings", null],
    ];
    const ids: string[] = [];
    for (const [, other_settings] of settings) {
      const owner = randomUUID();
      ids.push(
        await credential(owner, {
          claude_usage: reading(6 * HOUR),
          claude_usage_history: usedAuto(HOUR),
        }),
      );
      await query("UPDATE accounts SET other_settings=$2 WHERE account_id=$1", [
        owner,
        other_settings,
      ]);
      await project(owner, await host(), "running", 0);
    }
    // Turned on, but the account was deleted; and no account row at all.
    const deleted = randomUUID();
    ids.push(
      await credential(deleted, { claude_usage_history: usedAuto(HOUR) }),
    );
    await query("UPDATE accounts SET deleted=true WHERE account_id=$1", [
      deleted,
    ]);
    await project(deleted, await host(), "running", 0);
    const missing = randomUUID();
    ids.push(
      await credential(missing, { claude_usage_history: usedAuto(HOUR) }),
    );
    await query("DELETE FROM accounts WHERE account_id=$1", [missing]);
    await project(missing, await host(), "running", 0);

    expect(await dueClaudeUsageProbeRows(query, now)).toEqual([]);
    const { calls, deps: d } = deps(async () => ({
      observed_at: new Date(now).toISOString(),
    }));
    await expect(runClaudeUsageProbes(d, () => now)).resolves.toEqual({
      checked: 0,
      failed: 0,
    });
    expect(calls).toEqual([]);
    for (const id of ids) expect(await probeRecord(id)).toBeUndefined();

    // Turned on: checked as before.
    const { rows } = await query(
      "SELECT owner_account_id FROM external_credentials WHERE id=$1",
      [ids[0]],
    );
    await query("UPDATE accounts SET other_settings=$2 WHERE account_id=$1", [
      rows[0].owner_account_id,
      { claude_usage_refresh: true },
    ]);
    await runClaudeUsageProbes(d, () => now);
    expect(calls.map((c) => c.credential_id)).toEqual([ids[0]]);
  });

  // Turned off while a pass works on the subscription: when the due query
  // returns, during the claim, or during the project lookup. No request,
  // and the check recorded before the pass (here an old one) is kept.
  for (const [when, step] of [
    ["the pass chose it", "FROM external_credentials c"],
    ["the claim", "UPDATE external_credentials"],
    ["the project lookup", "FROM projects p"],
  ]) {
    test(`turned off during ${when}: no request, the old record kept`, async () => {
      const owner = randomUUID();
      const old = { at: new Date(now - 5 * HOUR).toISOString(), ok: true };
      const id = await credential(owner, {
        claude_usage_history: usedAuto(HOUR),
        claude_usage_probe: old,
      });
      await project(owner, await host(), "running", 0);
      const { calls, deps: d } = deps(async () => ({
        observed_at: new Date(now).toISOString(),
      }));
      let turnedOff = false;
      d.query = async (sql, values) => {
        const result = await query(sql, values);
        if (!turnedOff && sql.includes(step)) {
          turnedOff = true;
          await query(
            "UPDATE accounts SET other_settings=$2 WHERE account_id=$1",
            [owner, { claude_usage_refresh: false }],
          );
        }
        return result;
      };
      await expect(runClaudeUsageProbes(d, () => now)).resolves.toEqual({
        checked: 0,
        failed: 0,
      });
      expect(turnedOff).toBe(true);
      expect(calls).toEqual([]);
      expect(await probeRecord(id)).toEqual(old);
    });
  }

  test("turned off during the project lookup with no record before: none after", async () => {
    const owner = randomUUID();
    const id = await credential(owner, {
      claude_usage_history: usedAuto(HOUR),
    });
    await project(owner, await host(), "running", 0);
    const { calls, deps: d } = deps(async () => ({
      observed_at: new Date(now).toISOString(),
    }));
    d.query = async (sql, values) => {
      const result = await query(sql, values);
      if (sql.includes("FROM projects p"))
        await query(
          "UPDATE accounts SET other_settings=$2 WHERE account_id=$1",
          [owner, {}],
        );
      return result;
    };
    await runClaudeUsageProbes(d, () => now);
    expect(calls).toEqual([]);
    expect(await probeRecord(id)).toBeUndefined();
    // Turned on again: checked at once, with no check inherited.
    await query("UPDATE accounts SET other_settings=$2 WHERE account_id=$1", [
      owner,
      { claude_usage_refresh: true },
    ]);
    d.query = query;
    await runClaudeUsageProbes(d, () => now);
    expect(calls).toHaveLength(1);
  });

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

  test("the query and claudeUsageProbeDue agree on malformed values", async () => {
    const owner = randomUUID();
    const iso = (ms: number) => new Date(ms).toISOString();
    // Raw JSON numbers (a JS object cannot hold them as written).
    const RAW: Record<string, string> = {
      __HUGE__: "1e10000",
      // JSON.parse rounds these to 0.98 and to a whole number.
      __ROUNDS_TO_FULL__: "0.97999999999999999",
      __ROUNDS_TO_WHOLE__: `${sec(now + HOUR)}.00000000000001`,
    };
    const HUGE = "__HUGE__";
    const observed = [
      undefined,
      iso(now - 10 * HOUR),
      iso(now - HOUR),
      iso(now + 4 * 60_000),
      iso(now + 6 * 60_000),
      "9999-99-99T99:99:99Z",
      "9999-01-01T00:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      iso(now - HOUR).replace(/\.\d{3}Z$/, "Z"),
      "zzzz",
      5,
    ];
    const checked = [
      undefined,
      iso(now - HOUR),
      iso(now - 5 * HOUR),
      "zzzz",
      "9999-01-01T00:00:00.000Z",
      "9999-99-99T99:99:99Z",
    ];
    const until = [
      undefined,
      iso(now + HOUR),
      iso(now - HOUR),
      "zzzz",
      "9999-99-99T99:99:99Z",
    ];
    const fiveHour = [
      undefined,
      { utilization: 1, resets_at: sec(now + HOUR) },
      { utilization: 1, resets_at: sec(now + HOUR) + 0.5 },
      { utilization: 1, resets_at: sec(now + 366 * 24 * HOUR) },
      { utilization: 1, resets_at: sec(now + 366 * 24 * HOUR) + 1 },
      { utilization: 11, resets_at: sec(now + HOUR) },
      { utilization: 0.5, resets_at: sec(now + HOUR) },
      { utilization: HUGE, resets_at: sec(now + HOUR) },
      { utilization: 1, resets_at: HUGE },
      { utilization: "1", resets_at: sec(now + HOUR) },
      { utilization: "__ROUNDS_TO_FULL__", resets_at: sec(now + HOUR) },
      { utilization: 1, resets_at: "__ROUNDS_TO_WHOLE__" },
    ];
    const excluded = [undefined, true, "true"];
    const dims = [observed, checked, until, fiveHour, excluded];
    // Coprime with each length: every value, and every pair, appears.
    const primes = [1, 5, 3, 7, 2];
    const ids: string[] = [];
    for (let i = 0; i < 700; i++) {
      const [o, c, u, f, e] = dims.map(
        (values, d) =>
          values[(Math.floor(i / (d + 1)) * primes[d]) % values.length],
      ) as any[];
      const metadata: Record<string, any> = {
        claude_usage_history: usedAuto(HOUR),
      };
      if (o !== undefined || f !== undefined)
        metadata.claude_usage = {
          ...(o !== undefined ? { observed_at: o } : {}),
          windows: f !== undefined ? { five_hour: f } : {},
        };
      if (c !== undefined) metadata.claude_usage_probe = { at: c };
      if (u !== undefined) metadata.claude_pool_limited = { until: u };
      if (e !== undefined) metadata.claude_pool_excluded = e;
      ids.push(
        await credential(
          owner,
          Object.entries(RAW).reduce(
            (json, [marker, raw]) => json.replaceAll(`"${marker}"`, raw),
            JSON.stringify(metadata),
          ),
        ),
      );
    }
    // What code decides, on the values as they come back from the database.
    const { rows } = await query(
      "SELECT id, metadata FROM external_credentials WHERE owner_account_id=$1",
      [owner],
    );
    const expected = rows
      .filter((row) => claudeUsageProbeDue(row.metadata, now))
      .map((row) => row.id)
      .sort();
    const actual = (await dueClaudeUsageProbeRows(query, now, 10_000))
      .map((row) => row.id)
      .sort();
    expect(expected.length).toBeGreaterThan(50);
    expect(expected.length).toBeLessThan(ids.length - 50);
    expect(actual).toEqual(expected);
  }, 60_000);

  test("windows a double sees as full cannot fill every pass", async () => {
    const owner = randomUUID();
    // Older readings than the real candidate, each with a 5-hour window
    // that code (JSON.parse) sees as full: 0.97999999999999999 is 0.98.
    for (let i = 0; i < 12; i++)
      await credential(
        owner,
        `{"claude_usage": {"observed_at": "${new Date(now - (20 + i) * HOUR).toISOString()}",
          "windows": {"five_hour": {"utilization": 0.97999999999999999, "resets_at": ${sec(now + HOUR)}}}},
          "claude_usage_history": ${JSON.stringify(usedAuto(HOUR))}}`,
      );
    const real = await credential(owner, {
      claude_usage: reading(6 * HOUR),
      claude_usage_history: usedAuto(HOUR),
    });
    await project(owner, await host(), "running", 0);
    const { calls, deps: d } = deps(async () => ({
      observed_at: new Date(now).toISOString(),
    }));
    await runClaudeUsageProbes(d, () => now);
    expect(calls.map((c) => c.credential_id)).toEqual([real]);
  });

  test("a row the query returns but code rejects is recorded, not retried", async () => {
    const owner = randomUUID();
    const id = await credential(owner, {
      claude_usage_history: usedAuto(HOUR),
    });
    await project(owner, await host(), "running", 0);
    const { calls, deps: d } = deps(async () => ({
      observed_at: new Date(now).toISOString(),
    }));
    // Make code disagree: the query's row looks excluded to code.
    const disagree: ClaudeUsageProbeDeps = {
      ...d,
      query: async (sql, values) => {
        const result = await query(sql, values);
        if (!sql.includes("FROM external_credentials c")) return result;
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            metadata: { ...row.metadata, claude_pool_excluded: true },
          })),
        };
      },
    };
    await runClaudeUsageProbes(disagree, () => now);
    expect(calls).toEqual([]);
    expect(await probeRecord(id)).toEqual({
      at: new Date(now).toISOString(),
      ok: false,
      error: "not due by the code rule",
    });
    expect(await dueClaudeUsageProbeRows(query, now)).toEqual([]);
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
