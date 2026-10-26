/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The Home page experiment's aggregate counts and report, on a real
// database (pglite).

import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import {
  getPublicHomeExperimentReport,
  probabilityBest,
  recordPublicHomeExperimentEvent,
  suggestedWeights,
} from "./public-home-experiment";

const mockMultiBay = jest.fn(() => false);
jest.mock("@cocalc/server/cluster-config", () => ({
  ...jest.requireActual("@cocalc/server/cluster-config"),
  isMultiBayCluster: () => mockMultiBay(),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const known = ["default", "math", "project"];
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 26, 12);

// A seeded generator, so the Thompson draws are repeatable.
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describeDb("public Home experiment counts", () => {
  beforeAll(async () => {
    await syncSchema({
      public_home_experiment_counts: SCHEMA.public_home_experiment_counts,
    });
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM public_home_experiment_counts");
  });

  async function record(
    variant: string,
    event: string,
    times: number,
    now = T0,
  ) {
    for (let i = 0; i < times; i++) {
      await recordPublicHomeExperimentEvent({
        variant,
        event,
        now: () => now,
        running: known,
      });
    }
  }

  it("adds one per event to a (day, version, event) total, and nothing else", async () => {
    await record("math", "view", 3);
    await record("math", "view", 2, T0 + DAY);
    await record("math", "signup", 1);
    expect(
      await recordPublicHomeExperimentEvent({
        variant: "nope",
        event: "view",
        running: known,
      }),
    ).toBe(false);
    expect(
      await recordPublicHomeExperimentEvent({
        variant: "math",
        event: "purchase",
        running: known,
      }),
    ).toBe(false);
    // A version that isn't running now, or the experiment being off,
    // counts nothing.
    expect(
      await recordPublicHomeExperimentEvent({
        variant: "math",
        event: "signup",
        running: ["default", "project"],
      }),
    ).toBe(false);
    expect(
      await recordPublicHomeExperimentEvent({
        variant: "math",
        event: "signup",
        running: [],
      }),
    ).toBe(false);
    const { rows } = await getPool().query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, variant, event, count::INT AS count
         FROM public_home_experiment_counts ORDER BY day, event`,
    );
    expect(rows).toEqual([
      { day: "2026-10-26", variant: "math", event: "signup", count: 1 },
      { day: "2026-10-26", variant: "math", event: "view", count: 3 },
      { day: "2026-10-27", variant: "math", event: "view", count: 2 },
    ]);
    // Only the aggregate columns exist: nothing identifies a visitor.
    const { rows: columns } = await getPool().query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'public_home_experiment_counts' ORDER BY column_name`,
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      "count",
      "day",
      "event",
      "variant",
    ]);
  });

  it("reports totals, rates and suggested weights over a window", async () => {
    await record("default", "view", 200);
    await record("default", "cta", 20);
    await record("default", "signup", 4);
    await record("math", "view", 200);
    await record("math", "cta", 40);
    await record("math", "signup", 20);
    // Outside the 7-day window:
    await record("math", "signup", 50, T0 - 10 * DAY);
    const report = await getPublicHomeExperimentReport({
      days: 7,
      now: () => T0,
      setting: "default:1, math:1",
      random: seeded(7),
    });
    expect(report.start_day).toBe("2026-10-20");
    expect(report.end_day).toBe("2026-10-26");
    const byId = Object.fromEntries(report.arms.map((a) => [a.id, a]));
    expect(byId.default).toMatchObject({
      views: 200,
      cta: 20,
      signups: 4,
      cta_rate: 0.1,
      signup_rate: 0.02,
    });
    expect(byId.math).toMatchObject({ views: 200, cta: 40, signups: 20 });
    expect(byId.math.p_best).toBeGreaterThan(0.99);
    // The floor keeps the weaker version measured.
    expect(byId.default.suggested_weight).toBeGreaterThan(0);
    expect(byId.math.suggested_weight).toBeGreaterThan(
      byId.default.suggested_weight,
    );
  });

  it("recommends only among the running versions", async () => {
    // math ran earlier in the window and was replaced by project.
    await record("default", "view", 200);
    await record("default", "signup", 4);
    await record("math", "view", 200);
    await record("math", "signup", 40);
    await record("project", "view", 100);
    await record("project", "signup", 3);
    const report = await getPublicHomeExperimentReport({
      days: 7,
      now: () => T0,
      setting: "default:1, project:1",
      random: seeded(7),
    });
    const byId = Object.fromEntries(report.arms.map((a) => [a.id, a]));
    // The stopped version keeps its totals, but no recommendation.
    expect(byId.math).toMatchObject({
      views: 200,
      signups: 40,
      weight: 0,
      p_best: 0,
      suggested_weight: 0,
    });
    const sum = (key: "p_best" | "suggested_weight") =>
      byId.default[key] + byId.project[key];
    expect(sum("p_best")).toBeCloseTo(1, 6);
    expect(sum("suggested_weight")).toBeCloseTo(1, 6);
    expect(byId.default.suggested_weight).toBeGreaterThanOrEqual(0.1);
    expect(byId.project.suggested_weight).toBeGreaterThanOrEqual(0.1);
  });
});

describeDb("public Home experiment report on a multi-bay site", () => {
  it("refuses rather than report one bay's counts as the whole", async () => {
    mockMultiBay.mockReturnValue(true);
    try {
      await expect(
        getPublicHomeExperimentReport({ setting: "default, math" }),
      ).rejects.toThrow(/single-bay/);
    } finally {
      mockMultiBay.mockReturnValue(false);
    }
  });
});

describe("Thompson sampling helpers", () => {
  it("gives equal arms about equal chances, and favors the better one", () => {
    const equal = probabilityBest(
      [
        { views: 1000, successes: 50 },
        { views: 1000, successes: 50 },
      ],
      seeded(3),
    );
    expect(Math.abs(equal[0] - 0.5)).toBeLessThan(0.05);
    const better = probabilityBest(
      [
        { views: 1000, successes: 30 },
        { views: 1000, successes: 60 },
      ],
      seeded(3),
    );
    expect(better[1]).toBeGreaterThan(0.99);
  });

  it("knows nothing without data", () => {
    const p = probabilityBest(
      [
        { views: 0, successes: 0 },
        { views: 0, successes: 0 },
        { views: 0, successes: 0 },
      ],
      seeded(5),
    );
    for (const x of p) expect(Math.abs(x - 1 / 3)).toBeLessThan(0.05);
  });

  it("keeps every weight above the floor", () => {
    expect(suggestedWeights([1, 0, 0], 0.1)).toEqual([0.8, 0.1, 0.1]);
    expect(suggestedWeights([0.9, 0.05, 0.05, 0], 0.1)).toEqual([
      0.7, 0.1, 0.1, 0.1,
    ]);
    expect(suggestedWeights([0.5, 0.5], 0.1)).toEqual([0.5, 0.5]);
    expect(suggestedWeights([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.1)).toEqual(
      Array(11).fill(0.09),
    );
    expect(suggestedWeights([])).toEqual([]);
  });
});
