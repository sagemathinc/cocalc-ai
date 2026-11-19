/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Fresh Claude readings for Auto (util/ai/claude-usage-probe), run on the
// home bay, where the credentials and their readings live. Every few minutes
// one pass finds the subscriptions of accounts using Auto whose reading is
// old and asks a host running one of the account's projects to check each
// (project-host/acp/claude-usage-probe.ts), which saves the reading as a
// turn would. Each check is claimed on its credential first, so hub
// processes of the bay never check the same subscription twice.

import getLogger from "@cocalc/backend/logger";
import {
  ANTHROPIC_API_PROVIDER,
  CLAUDE_SUBSCRIPTION_KIND,
} from "@cocalc/util/ai/external-credential-profiles";
import {
  CLAUDE_USAGE_PROBE_ACTIVE_MS,
  CLAUDE_USAGE_PROBE_AFTER_MS,
  CLAUDE_USAGE_PROBE_FULL,
  CLAUDE_USAGE_PROBE_FUTURE_MS,
  CLAUDE_USAGE_PROBE_MAX_RESET_MS,
  CLAUDE_USAGE_PROBE_METADATA_KEY,
  claudeUsageProbeDue,
} from "@cocalc/util/ai/claude-usage-probe";
import {
  claudeReadingAtSql,
  isoTimeSql,
} from "@cocalc/util/ai/claude-usage-sql";

const logger = getLogger("server:agents:claude-usage-probe");

const INTERVAL_MS = 15 * 60_000;
const FIRST_RUN_MS = 5 * 60_000;
// Checks per pass, one at a time: a check takes seconds.
const MAX_PER_PASS = 10;
const PROBE_TIMEOUT_MS = 120_000;

type Query = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: any[]; rowCount?: number | null }>;

export interface ClaudeUsageProbeDeps {
  query: Query;
  /** The host of one of the account's projects this bay can reach. */
  probe: (options: {
    host_id: string;
    project_id: string;
    account_id: string;
    credential_id: string;
  }) => Promise<{ observed_at: string }>;
  /** This bay: checks run on hosts it controls. */
  bayId: () => Promise<string>;
}

const defaultDeps: ClaudeUsageProbeDeps = {
  query: async (sql, values) => {
    const { default: getPool } = await import("@cocalc/database/pool");
    return await getPool().query(sql, values as any[]);
  },
  async probe({ host_id, ...options }) {
    const { getRoutedHostControlClient } =
      await import("@cocalc/server/project-host/client");
    const client = await getRoutedHostControlClient({
      host_id,
      timeout: PROBE_TIMEOUT_MS,
    });
    return await client.probeClaudeSubscriptionUsage(options);
  },
  async bayId() {
    const { getConfiguredBayId } = await import("@cocalc/server/bay-config");
    return getConfiguredBayId();
  },
};

// When the reading was taken, as stored ("" if none): the expression of the
// partial index on external_credentials.
const READING_AT = claudeReadingAtSql("c");
const FIVE_HOUR = "c.metadata->'claude_usage'->'windows'->'five_hour'";

interface Candidate {
  id: string;
  owner_account_id: string;
  metadata: Record<string, any>;
}

/**
 * The subscriptions to check now, oldest reading first, chosen in the
 * database: at most `limit` rows leave it. This is claudeUsageProbeDue
 * (util/ai/claude-usage-probe.ts) on the same raw values, plus "the account
 * used Auto lately": times count only as isIsoTime allows and then compare
 * as text (they sort in time order), numbers compare as numeric (which holds
 * any JSON number), so no value can fail the query. The partial index on the
 * reading time (util/db-schema/external-credentials.ts) serves the order.
 */
export async function dueClaudeUsageProbeRows(
  query: Query,
  now = Date.now(),
  limit = MAX_PER_PASS,
): Promise<Candidate[]> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const { rows } = await query(
    `SELECT c.id, c.owner_account_id, c.metadata
       FROM external_credentials c
      WHERE c.kind=$2 AND c.revoked IS NULL AND c.provider=$1
        AND c.scope='account' AND c.owner_account_id IS NOT NULL
        -- No reading, an old one, or one from the future.
        AND (${READING_AT} < $3 OR ${READING_AT} > $5)
        AND ${isoTimeSql("(c.metadata->'claude_usage_probe'->>'at')")} < $3
        AND c.metadata->'claude_pool_excluded' IS DISTINCT FROM 'true'::jsonb
        AND ${isoTimeSql("(c.metadata->'claude_pool_limited'->>'until')")} < $4
        -- Not a 5-hour window that was full and has not reset.
        AND NOT COALESCE(
          CASE WHEN jsonb_typeof(${FIVE_HOUR}->'utilization') = 'number'
                AND jsonb_typeof(${FIVE_HOUR}->'resets_at') = 'number'
               THEN (${FIVE_HOUR}->'utilization')::numeric BETWEEN $6::numeric AND 10
                AND (${FIVE_HOUR}->'resets_at')::numeric
                    = trunc((${FIVE_HOUR}->'resets_at')::numeric)
                AND (${FIVE_HOUR}->'resets_at')::numeric > $7::numeric
                AND (${FIVE_HOUR}->'resets_at')::numeric <= $8::numeric
          END, false)
        -- The account used Auto lately: a pick recorded a reading.
        AND EXISTS (
          SELECT 1 FROM external_credentials h
           WHERE h.owner_account_id=c.owner_account_id AND h.kind=$2
             AND h.provider=$1 AND h.scope='account' AND h.revoked IS NULL
             AND CASE WHEN h.metadata->'claude_usage_history'->-1->>'at'
                           ~ '^[0-9]{1,16}$'
                      THEN (h.metadata->'claude_usage_history'->-1->>'at')::bigint > $9
                      ELSE false END)
      ORDER BY ${READING_AT}
      LIMIT $10`,
    [
      ANTHROPIC_API_PROVIDER,
      CLAUDE_SUBSCRIPTION_KIND,
      iso(now - CLAUDE_USAGE_PROBE_AFTER_MS),
      iso(now),
      iso(now + CLAUDE_USAGE_PROBE_FUTURE_MS),
      CLAUDE_USAGE_PROBE_FULL,
      now / 1000,
      (now + CLAUDE_USAGE_PROBE_MAX_RESET_MS) / 1000,
      now - CLAUDE_USAGE_PROBE_ACTIVE_MS,
      limit,
    ],
  );
  return rows as Candidate[];
}

/** The subscriptions to check now (dueClaudeUsageProbeRows), with the rule
 * applied again in code as a guard. */
export async function dueClaudeUsageProbes(
  query: Query,
  now = Date.now(),
  limit = MAX_PER_PASS,
): Promise<Candidate[]> {
  return (await dueClaudeUsageProbeRows(query, now, limit)).filter((row) =>
    claudeUsageProbeDue(row.metadata, now),
  );
}

async function setProbe(
  query: Query,
  id: string,
  value: unknown,
  previous?: unknown,
): Promise<boolean> {
  // With `previous`, only if the stored check is still that one (a claim).
  const { rowCount } = await query(
    `UPDATE external_credentials
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
                                 ARRAY[$2::text], $3::jsonb, true)
      WHERE id=$1 AND revoked IS NULL
        AND ($4::boolean IS NOT TRUE
             OR metadata->$2::text IS NOT DISTINCT FROM $5::jsonb)`,
    [
      id,
      CLAUDE_USAGE_PROBE_METADATA_KEY,
      JSON.stringify(value),
      previous !== undefined,
      previous === undefined || previous === null
        ? null
        : JSON.stringify(previous),
    ],
  );
  return !!rowCount;
}

async function projectFor(
  deps: ClaudeUsageProbeDeps,
  account_id: string,
): Promise<{ project_id: string; host_id: string } | undefined> {
  // Only hosts this bay controls (as resolveHostBayDirect decides), before
  // the limit: other bays' hosts cannot run the check.
  const { rows } = await deps.query(
    `SELECT p.project_id, p.host_id FROM projects p
       JOIN project_hosts h ON h.id = p.host_id AND h.deleted IS NULL
      WHERE p.deleted IS NOT TRUE
        AND COALESCE(h.bay_id, $2) = $2
        AND p.users -> $1::text ->> 'group' IN ('owner', 'collaborator')
      ORDER BY COALESCE(p.state->>'state', '') = 'running' DESC,
               p.last_edited DESC NULLS LAST
      LIMIT 1`,
    [account_id, await deps.bayId()],
  );
  return rows[0];
}

/** One pass: check each due subscription. Returns how many were checked. */
export async function runClaudeUsageProbes(
  deps: ClaudeUsageProbeDeps = defaultDeps,
  now = () => Date.now(),
): Promise<{ checked: number; failed: number }> {
  let checked = 0;
  let failed = 0;
  for (const row of await dueClaudeUsageProbes(deps.query, now())) {
    const previous = row.metadata?.[CLAUDE_USAGE_PROBE_METADATA_KEY] ?? null;
    const at = new Date(now()).toISOString();
    if (!(await setProbe(deps.query, row.id, { at }, previous))) continue;
    let error: string | undefined;
    try {
      const project = await projectFor(deps, row.owner_account_id);
      if (!project) throw Error("no project on a host of this bay");
      await deps.probe({
        ...project,
        account_id: row.owner_account_id,
        credential_id: row.id,
      });
      checked += 1;
    } catch (err) {
      failed += 1;
      error = `${(err as Error)?.message ?? err}`.slice(0, 300);
      logger.debug("Claude usage check failed", { id: row.id, error });
    }
    await setProbe(
      deps.query,
      row.id,
      error ? { at, ok: false, error } : { at, ok: true },
    );
  }
  return { checked, failed };
}

/** The periodic checks; off when COCALC_CLAUDE_USAGE_PROBE is "off". */
export function startClaudeUsageProbes(): () => void {
  if (process.env.COCALC_CLAUDE_USAGE_PROBE === "off") return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (stopped) return;
    try {
      const result = await runClaudeUsageProbes();
      if (result.checked || result.failed)
        logger.info("checked Claude subscription limits", result);
    } catch (error) {
      logger.warn("Claude usage checks failed", { error: `${error}` });
    } finally {
      if (!stopped) {
        timer = setTimeout(run, INTERVAL_MS);
        timer.unref();
      }
    }
  };
  timer = setTimeout(run, FIRST_RUN_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
