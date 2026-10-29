/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

/*
Health of site-funded AI turns (Codex and Claude), per provider, over the
last hour, from the seed bay's site_ai_turn_reservations and
site_ai_admission_attempts. Admins get a condition alert, and admin health a
line, when

- more than 10% of finished turns (including turns released because they
  could not be set up) failed for a reason other than a limit
  (the cost, request and duration limits of a turn, "emergency" ones for
  Codex, and expired turns, are limits by design), out of at least 5
  finished turns; or
- at least 5 turns were admitted (and have had 15 minutes to finish) but
  none completed.

It costs nothing: it reads what the turns already record.
*/

import getPool from "@cocalc/database/pool";
import { conditionAlert, conditionCleared } from "../hosts/condition-alert";

export const SITE_AI_HEALTH_WINDOW_MINUTES = 60;
export const SITE_AI_MAX_FAILURE_RATE = 0.1;
export const SITE_AI_MIN_FINISHED_TURNS = 5;
export const SITE_AI_MIN_ADMITTED_TURNS = 5;
// A turn admitted more recently may still be running.
export const SITE_AI_ADMISSION_SETTLE_MINUTES = 15;
const PROVIDERS = ["openai", "anthropic"];
// "reached its emergency cost limit" (Codex, site-funded-proxy.ts), "reached
// its cost limit" (Claude, site-funded-claude-relay.ts) and "reached its
// 1-hour limit" (both, siteFundedTurnEndedMessage in util/ai). "CoCalc ended
// this included turn" is not a limit.
const LIMIT_OUTCOME =
  /\b(cost|request|duration) limit\b|\breached its \d+-(hour|minute) limit\b/i;
// Released turns are normally closed ones ("app-server runtime closed",
// "Claude harness closed", "superseded by a new turn"), but a turn that could
// not be set up is released too: "provider proxy failed to start" or "failed
// to activate" (Codex), "site key unavailable" (Claude). Those are failures.
const RELEASED_FAILURE = /\bfailed to (start|activate)\b|\bunavailable\b/i;
const ALERT_SUBJECT = "Site-funded AI turns are failing";
const ALERT_REMINDER_MINUTES = 6 * 60;
const TOP_FAILURES = 3;
const MAX_OUTCOME_LENGTH = 160;

// Served by site_ai_turn_reservations_completed_idx, whose predicate the
// status filter matches.
export const FINISHED_TURNS_SQL = `SELECT provider, status, outcome, count(*)::int AS turns
   FROM site_ai_turn_reservations
  WHERE completed_at >= $1::timestamptz - make_interval(mins => $2)
    AND completed_at <= $1::timestamptz
    AND status IN ('committed', 'failed', 'expired', 'released')
  GROUP BY provider, status, outcome`;

export interface SiteFundedAiProviderHealth {
  provider: string;
  committed: number;
  // Failed for a reason other than a limit.
  failed: number;
  limited: number;
  // Admitted at least SITE_AI_ADMISSION_SETTLE_MINUTES ago, within the window.
  admitted: number;
  top_failures: { outcome: string; turns: number }[];
  failure_rate_exceeded: boolean;
  nothing_completes: boolean;
}

export interface SiteFundedAiHealth {
  window_minutes: number;
  providers: SiteFundedAiProviderHealth[];
}

export async function getSiteFundedAiHealth({
  now = new Date(),
}: { now?: Date } = {}): Promise<SiteFundedAiHealth> {
  const pool = getPool();
  const [turns, admissions] = await Promise.all([
    pool.query<{
      provider: string;
      status: string;
      outcome: string | null;
      turns: number;
    }>(FINISHED_TURNS_SQL, [now, SITE_AI_HEALTH_WINDOW_MINUTES]),
    pool.query<{ provider: string; admitted: number }>(
      `SELECT provider, count(*)::int AS admitted
         FROM site_ai_admission_attempts
        WHERE outcome = 'allowed'
          -- When it was allowed: a retry keeps the first attempt's time.
          AND decided_at >= $1::timestamptz - make_interval(mins => $2)
          AND decided_at < $1::timestamptz - make_interval(mins => $3)
          -- Bounds the scan (attempted_at is indexed; retries are quick).
          AND attempted_at >= $1::timestamptz - INTERVAL '1 day'
        GROUP BY provider`,
      [now, SITE_AI_HEALTH_WINDOW_MINUTES, SITE_AI_ADMISSION_SETTLE_MINUTES],
    ),
  ]);
  const byProvider = new Map<string, SiteFundedAiProviderHealth>();
  const get = (provider: string) => {
    let health = byProvider.get(provider);
    if (!health) {
      health = {
        provider,
        committed: 0,
        failed: 0,
        limited: 0,
        admitted: 0,
        top_failures: [],
        failure_rate_exceeded: false,
        nothing_completes: false,
      };
      byProvider.set(provider, health);
    }
    return health;
  };
  for (const provider of PROVIDERS) get(provider);
  const failures = new Map<string, Map<string, number>>();
  for (const row of turns.rows) {
    const health = get(row.provider);
    const count = Number(row.turns) || 0;
    if (
      row.status === "released" &&
      !RELEASED_FAILURE.test(row.outcome ?? "")
    ) {
      continue;
    }
    if (row.status === "committed") {
      health.committed += count;
    } else if (
      row.status === "expired" ||
      LIMIT_OUTCOME.test(row.outcome ?? "")
    ) {
      health.limited += count;
    } else {
      health.failed += count;
      const outcome = (row.outcome ?? "no reason recorded").slice(
        0,
        MAX_OUTCOME_LENGTH,
      );
      const counts = failures.get(row.provider) ?? new Map<string, number>();
      counts.set(outcome, (counts.get(outcome) ?? 0) + count);
      failures.set(row.provider, counts);
    }
  }
  for (const row of admissions.rows) {
    get(row.provider).admitted += Number(row.admitted) || 0;
  }
  for (const health of byProvider.values()) {
    health.top_failures = [...(failures.get(health.provider) ?? new Map())]
      .map(([outcome, turns]) => ({ outcome, turns }))
      .sort((a, b) => b.turns - a.turns || a.outcome.localeCompare(b.outcome))
      .slice(0, TOP_FAILURES);
    const finished = health.committed + health.failed + health.limited;
    health.failure_rate_exceeded =
      finished >= SITE_AI_MIN_FINISHED_TURNS &&
      health.failed / finished > SITE_AI_MAX_FAILURE_RATE;
    health.nothing_completes =
      health.admitted >= SITE_AI_MIN_ADMITTED_TURNS && health.committed === 0;
  }
  return {
    window_minutes: SITE_AI_HEALTH_WINDOW_MINUTES,
    providers: [...byProvider.values()].sort((a, b) =>
      a.provider.localeCompare(b.provider),
    ),
  };
}

export function siteFundedAiHealthLevel(
  health: SiteFundedAiHealth,
): "healthy" | "warning" | "critical" {
  if (health.providers.some((p) => p.nothing_completes)) return "critical";
  if (health.providers.some((p) => p.failure_rate_exceeded)) return "warning";
  return "healthy";
}

// One stable line per failing provider: counts and reasons go to admin
// health, so that an unchanged condition keeps an unchanged alert body.
function problemLines(health: SiteFundedAiHealth): string[] {
  const lines: string[] = [];
  for (const p of health.providers) {
    if (p.nothing_completes) {
      lines.push(
        `- ${p.provider}: turns are admitted but none completed in the last ${health.window_minutes} minutes`,
      );
    } else if (p.failure_rate_exceeded) {
      lines.push(
        `- ${p.provider}: more than ${Math.round(SITE_AI_MAX_FAILURE_RATE * 100)}% of finished turns failed (not counting limits) in the last ${health.window_minutes} minutes`,
      );
    }
  }
  return lines;
}

export function siteFundedAiHealthSummary(health: SiteFundedAiHealth): string {
  return health.providers
    .map(
      (p) =>
        `${p.provider}: ${p.committed} completed, ${p.failed} failed, ${p.limited} stopped by limits`,
    )
    .join("; ")
    .concat(` (site-funded turns, last ${health.window_minutes} minutes).`);
}

export function siteFundedAiHealthDetails(
  health: SiteFundedAiHealth,
): string[] {
  return [
    ...problemLines(health).map((line) => line.slice(2)),
    ...health.providers.flatMap((p) =>
      p.top_failures.map(
        (f) => `${p.provider} failure (${f.turns} turns): ${f.outcome}`,
      ),
    ),
  ];
}

// Alert admins while either condition holds; clear it once neither does.
export async function runSiteFundedAiAlertCheck({
  now = new Date(),
}: { now?: Date } = {}): Promise<number> {
  const health = await getSiteFundedAiHealth({ now });
  const lines = problemLines(health);
  if (!lines.length) {
    await conditionCleared(ALERT_SUBJECT);
    return 0;
  }
  await conditionAlert({
    subject: ALERT_SUBJECT,
    body: [
      ...lines,
      "",
      "See admin health (site-funded-ai) for counts and the most common failure reasons.",
    ].join("\n"),
    reminderMinutes: ALERT_REMINDER_MINUTES,
  });
  return lines.length;
}
