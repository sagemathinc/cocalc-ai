/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Aggregate counts for the public Home page experiment
// (util/public-home-experiment.ts), and the report that compares versions.
// Nothing here identifies a visitor or an account: each event only adds one
// to a (day, version, event) total.

import { getLogger } from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import {
  isPublicHomeExperimentEvent,
  isPublicHomeVariantId,
  parsePublicHomeExperimentArms,
  type PublicHomeExperimentArm,
  type PublicHomeExperimentEvent,
} from "@cocalc/util/public-home-experiment";

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> };

const logger = getLogger("server:public-home-experiment");

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The versions the experiment runs now (empty while it is off). */
export async function runningPublicHomeVariants(): Promise<string[]> {
  const setting = (await getServerSettings()).public_home_experiment;
  return parsePublicHomeExperimentArms(setting).map((arm) => arm.id);
}

/** Add one to today's count for a version and event. Only versions the
 * experiment runs now are counted, so direct, stale or preview links to a
 * version that is off count nothing; unknown events are ignored too. Returns
 * whether it counted. */
export async function recordPublicHomeExperimentEvent({
  variant,
  event,
  db = getPool(),
  now = Date.now,
  running,
}: {
  variant: unknown;
  event: unknown;
  db?: Queryable;
  now?: () => number;
  running?: readonly string[];
}): Promise<boolean> {
  if (!isPublicHomeExperimentEvent(event)) return false;
  const active = running ?? (await runningPublicHomeVariants());
  if (!isPublicHomeVariantId(variant, active)) return false;
  await db.query(
    `INSERT INTO public_home_experiment_counts(day, variant, event, count)
     VALUES($1::DATE, $2, $3, 1)
     ON CONFLICT (day, variant, event)
     DO UPDATE SET count = public_home_experiment_counts.count + 1`,
    [utcDay(now()), variant, event],
  );
  return true;
}

/** Count a sign-up that came from a Home version. The account creation paths
 * call this after the account exists (the version is never stored on it).
 * Best effort: never throws. */
export async function countPublicHomeExperimentSignup(
  variant: unknown,
): Promise<void> {
  if (variant == null || variant === "") return;
  try {
    await recordPublicHomeExperimentEvent({ variant, event: "signup" });
  } catch (err) {
    logger.warn("counting a home experiment sign-up failed", {
      err: `${err}`.slice(0, 200),
    });
  }
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
   * among the running versions (Thompson sampling on Beta posteriors); the
   * basis of suggested_weight. 0 for a version that is not running, unless
   * nothing runs, when every recorded version is compared. */
  p_best: number;
  /** A suggested weight: p_best, but never below the floor; 0 for versions
   * that are not running. The running ones' suggestions sum to 1. */
  suggested_weight: number;
}

export interface PublicHomeExperimentReport {
  /** The bay whose counts these are: the only one, see below. */
  bay_id: string;
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
  // The counts are kept on the bay that served each request. Summing them
  // across bays is not implemented yet, and a report from one bay of several
  // would look complete while it is not, so refuse instead.
  if (isMultiBayCluster()) {
    throw new Error(
      "the Home experiment report covers single-bay sites only; summing counts across bays is not implemented yet",
    );
  }
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
  // Recommend only among the running versions: a stopped one keeps its
  // totals for comparison but gets p_best and suggested_weight 0, so the
  // suggestion sums to 1 over the versions that can actually be weighted.
  // With nothing running, p_best still compares everything recorded.
  const ranked = arms
    .map((arm, i) => ({ arm, i }))
    .filter(({ arm }) => running.length === 0 || arm.weight > 0);
  const p = probabilityBest(
    ranked.map(({ arm }) => ({ views: arm.views, successes: arm.signups })),
    random,
  );
  const suggested = running.length > 0 ? suggestedWeights(p) : p.map(() => 0);
  const pBest = arms.map(() => 0);
  const suggestedWeight = arms.map(() => 0);
  ranked.forEach(({ i }, k) => {
    pBest[i] = p[k];
    suggestedWeight[i] = suggested[k];
  });
  return {
    bay_id: getConfiguredBayId(),
    setting: value,
    running: running.length > 0,
    start_day: start,
    end_day: end,
    arms: arms.map((arm, i) => ({
      ...arm,
      p_best: pBest[i],
      suggested_weight: suggestedWeight[i],
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

/** Weights proportional to p_best, except that every version keeps at least
 * `floor` of the traffic, so that none stops being measured. The floored
 * versions get exactly the floor and the rest share what remains in
 * proportion to p_best. With more than 1/floor versions no floor fits, and
 * every version gets an equal share instead. Rounded to 2 places. */
export function suggestedWeights(p: number[], floor = FLOOR): number[] {
  const n = p.length;
  if (n === 0) return [];
  if (floor * n >= 1) return p.map(() => Math.round((1 / n) * 100) / 100);
  const floored = new Set<number>();
  for (;;) {
    const free = p.map((_, i) => i).filter((i) => !floored.has(i));
    const mass = 1 - floor * floored.size;
    const total = free.reduce((sum, i) => sum + Math.max(p[i], 0), 0);
    const share = (i: number) =>
      total > 0 ? (mass * Math.max(p[i], 0)) / total : mass / free.length;
    const below = free.filter((i) => share(i) < floor);
    if (below.length === 0) {
      return p.map(
        (_, i) => Math.round((floored.has(i) ? floor : share(i)) * 100) / 100,
      );
    }
    for (const i of below) floored.add(i);
  }
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
