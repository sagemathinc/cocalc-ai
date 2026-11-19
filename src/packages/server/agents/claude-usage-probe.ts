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
  CLAUDE_USAGE_PROBE_METADATA_KEY,
  claudeAccountUsesAuto,
  claudeUsageProbeDue,
} from "@cocalc/util/ai/claude-usage-probe";
import {
  CLAUDE_USAGE_METADATA_KEY,
  parseClaudeRateLimitSnapshot,
} from "@cocalc/util/ai/claude-usage";

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
  /** Whether this bay controls the host. */
  ownsHost: (host_id: string) => Promise<boolean>;
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
  async ownsHost(host_id) {
    const { resolveHostBayAcrossCluster } =
      await import("@cocalc/server/inter-bay/directory");
    const { getConfiguredBayId } = await import("@cocalc/server/bay-config");
    const owner = await resolveHostBayAcrossCluster(host_id);
    return owner?.bay_id === getConfiguredBayId();
  },
};

interface Candidate {
  id: string;
  owner_account_id: string;
  metadata: Record<string, any>;
}

/** The subscriptions to check now, oldest reading first. */
export async function dueClaudeUsageProbes(
  query: Query,
  now = Date.now(),
  limit = MAX_PER_PASS,
): Promise<Candidate[]> {
  const { rows } = await query(
    `SELECT id, owner_account_id, metadata FROM external_credentials
      WHERE provider=$1 AND kind=$2 AND scope='account'
        AND owner_account_id IS NOT NULL AND revoked IS NULL`,
    [ANTHROPIC_API_PROVIDER, CLAUDE_SUBSCRIPTION_KIND],
  );
  const byAccount = new Map<string, Candidate[]>();
  for (const row of rows as Candidate[]) {
    const list = byAccount.get(row.owner_account_id) ?? [];
    list.push(row);
    byAccount.set(row.owner_account_id, list);
  }
  const due: Candidate[] = [];
  for (const list of byAccount.values()) {
    if (!claudeAccountUsesAuto(list, now)) continue;
    for (const row of list)
      if (claudeUsageProbeDue(row.metadata, now)) due.push(row);
  }
  const observed = (row: Candidate) => {
    const reading = parseClaudeRateLimitSnapshot(
      row.metadata?.[CLAUDE_USAGE_METADATA_KEY],
      now,
    );
    return reading ? Date.parse(reading.observed_at) : 0;
  };
  return due.sort((a, b) => observed(a) - observed(b)).slice(0, limit);
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
  const { rows } = await deps.query(
    `SELECT project_id, host_id FROM projects
      WHERE deleted IS NOT TRUE AND host_id IS NOT NULL
        AND users -> $1::text ->> 'group' IN ('owner', 'collaborator')
      ORDER BY COALESCE(state->>'state', '') = 'running' DESC,
               last_edited DESC NULLS LAST
      LIMIT 5`,
    [account_id],
  );
  for (const row of rows) {
    if (await deps.ownsHost(row.host_id)) return row;
  }
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
