/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Aggregate counts for the public Home page experiment
// (util/public-home-experiment.ts), and the report that compares versions.
// Nothing here identifies a visitor or an account: each event only adds one
// to a (day, version, event) total.

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  isPublicHomeExperimentEvent,
  isPublicHomeVariantId,
  parsePublicHomeExperimentArms,
  PUBLIC_HOME_VARIANTS,
  type PublicHomeExperimentArm,
  type PublicHomeExperimentEvent,
} from "@cocalc/util/public-home-experiment";

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> };

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Add one to today's count for a version and event. Unknown versions and
 * events are ignored (returns false). */
export async function recordPublicHomeExperimentEvent({
  variant,
  event,
  db = getPool(),
  now = Date.now,
  known = PUBLIC_HOME_VARIANTS,
}: {
  variant: unknown;
  event: unknown;
  db?: Queryable;
  now?: () => number;
  known?: readonly string[];
}): Promise<boolean> {
  if (!isPublicHomeVariantId(variant, known)) return false;
  if (!isPublicHomeExperimentEvent(event)) return false;
  await db.query(
    `INSERT INTO public_home_experiment_counts(day, variant, event, count)
     VALUES($1::DATE, $2, $3, 1)
     ON CONFLICT (day, variant, event)
     DO UPDATE SET count = public_home_experiment_counts.count + 1`,
    [utcDay(now()), variant, event],
  );
  return true;
}

export interface PublicHomeExperimentArmReport {
  id: string;
  /** The weight it runs with now (0 if it is not running). */
  weight: number;
  views: number;
  cta: number;
  signups: number;
  /** cta / views and signups / views; null without views. */
  cta_rate: number | null;
  signup_rate: number | null;
  /** Estimated probability that this version has the highest sign-up rate
   * (Thompson sampling on Beta posteriors); the basis of suggested_weight. */
  p_best: number;
  /** A suggested weight: p_best, but never below the floor. */
  suggested_weight: number;
}

export interface PublicHomeExperimentReport {
  setting: string;
  running: boolean;
  start_day: string;
  end_day: string;
  arms: PublicHomeExperimentArmReport[];
}

const FLOOR = 0.1;
const DRAWS = 4000;

/** Compare the versions over the last `days` UTC days (including today). */
export async function getPublicHomeExperimentReport({
  days = 28,
  db = getPool(),
  now = Date.now,
  setting,
  random = Math.random,
}: {
  days?: number;
  db?: Queryable;
  now?: () => number;
  setting?: string;
  random?: () => number;
} = {}): Promise<PublicHomeExperimentReport> {
  const span = Math.min(Math.max(Math.floor(days), 1), 366);
  const end = utcDay(now());
  const start = utcDay(now() - (span - 1) * 86_400_000);
  const value =
    setting ??
    `${(await getServerSettings()).public_home_experiment ?? ""}`.trim();
  const running = parsePublicHomeExperimentArms(value);
  const { rows } = await db.query(
    `SELECT variant, event, SUM(count)::BIGINT AS total
       FROM public_home_experiment_counts
      WHERE day BETWEEN $1::DATE AND $2::DATE
      GROUP BY variant, event`,
    [start, end],
  );
  const ids = new Set<string>(running.map((arm) => arm.id));
  for (const row of rows) ids.add(row.variant);
  const total = (id: string, event: PublicHomeExperimentEvent) =>
    Number(
      rows.find((row) => row.variant === id && row.event === event)?.total ?? 0,
    );
  const arms = [...ids].map((id) => {
    const views = total(id, "view");
    const cta = total(id, "cta");
    const signups = total(id, "signup");
    return {
      id,
      weight: running.find((arm) => arm.id === id)?.weight ?? 0,
      views,
      cta,
      signups,
      cta_rate: views > 0 ? cta / views : null,
      signup_rate: views > 0 ? signups / views : null,
    };
  });
  const p = probabilityBest(
    arms.map(({ views, signups }) => ({ views, successes: signups })),
    random,
  );
  return {
    setting: value,
    running: running.length > 0,
    start_day: start,
    end_day: end,
    arms: arms.map((arm, i) => ({
      ...arm,
      p_best: p[i],
      suggested_weight: suggestedWeights(p)[i],
    })),
  };
}

/** Thompson sampling: for each arm, the share of posterior draws in which it
 * has the highest rate, with a Beta(1 + successes, 1 + failures) posterior. */
export function probabilityBest(
  arms: { views: number; successes: number }[],
  random: () => number = Math.random,
  draws = DRAWS,
): number[] {
  if (arms.length === 0) return [];
  const wins = arms.map(() => 0);
  for (let d = 0; d < draws; d++) {
    let best = -1;
    let bestValue = -1;
    arms.forEach(({ views, successes }, i) => {
      const s = Math.max(0, Math.min(successes, views));
      const x = sampleBeta(1 + s, 1 + views - s, random);
      if (x > bestValue) {
        bestValue = x;
        best = i;
      }
    });
    wins[best] += 1;
  }
  return wins.map((w) => w / draws);
}

/** Weights proportional to p_best, raised to a floor so that no version
 * stops being measured, normalized to sum to 1 (rounded to 2 places). */
export function suggestedWeights(p: number[], floor = FLOOR): number[] {
  if (p.length === 0) return [];
  const floored = p.map((x) => Math.max(x, floor));
  const sum = floored.reduce((a, b) => a + b, 0);
  return floored.map((x) => Math.round((x / sum) * 100) / 100);
}

// Beta(a, b) from two Gamma draws (Marsaglia and Tsang, a, b >= 1 here).
function sampleBeta(a: number, b: number, random: () => number): number {
  const x = sampleGamma(a, random);
  const y = sampleGamma(b, random);
  return x / (x + y);
}

function sampleGamma(shape: number, random: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleNormal(random: () => number): number {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type { PublicHomeExperimentArm };
