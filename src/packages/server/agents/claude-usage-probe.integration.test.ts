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
    metadata: Record<string, unknown>,
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
    });
  });
  beforeEach(async () => {
    await query("DELETE FROM external_credentials");
    await query("DELETE FROM projects");
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
    const due = await dueClaudeUsageProbes(query, now);
    expect(due.map((row) => row.id)).toEqual([staler, stale]);
  });

  function deps(
    probe: ClaudeUsageProbeDeps["probe"],
    owned = (_host: string) => true,
  ) {
    const calls: any[] = [];
    return {
      calls,
      deps: {
        query,
        probe: async (options) => {
          calls.push(options);
          return await probe(options);
        },
        ownsHost: async (host) => owned(host),
      } satisfies ClaudeUsageProbeDeps,
    };
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

  test("checks on a running project's host of this bay, once per four hours", async () => {
    const owner = randomUUID();
    const id = await credential(owner, {
      claude_usage: reading(6 * HOUR),
      claude_usage_history: usedAuto(HOUR),
    });
    const elsewhere = randomUUID();
    const host = randomUUID();
    await project(owner, elsewhere, "running", 0);
    await project(owner, host, "opened", 0);
    const running = await project(owner, host, "running", 5 * HOUR);
    const { calls, deps: d } = deps(
      async () => ({ observed_at: new Date(now).toISOString() }),
      (h) => h === host,
    );
    await expect(runClaudeUsageProbes(d, () => now)).resolves.toEqual({
      checked: 1,
      failed: 0,
    });
    expect(calls).toEqual([
      {
        host_id: host,
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
    await project(owner, randomUUID(), "running", 0);
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
    await project(owner, randomUUID(), "running", 0);
    const { calls, deps: d } = deps(
      async () => ({ observed_at: "" }),
      () => false,
    );
    await runClaudeUsageProbes(d, () => now);
    expect(calls).toEqual([]);
    expect((await probeRecord(id)).error).toMatch(/no project/);
  });

  test("concurrent passes check a subscription once", async () => {
    const owner = randomUUID();
    await credential(owner, { claude_usage_history: usedAuto(HOUR) });
    await project(owner, randomUUID(), "running", 0);
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
