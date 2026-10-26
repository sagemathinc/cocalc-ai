/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  isPublicHomeExperimentEvent,
  isPublicHomeVariantId,
  parsePublicHomeExperimentArms,
  pickPublicHomeVariant,
  PUBLIC_HOME_VARIANTS,
  withPublicHomeVariant,
} from "./public-home-experiment";

const known = ["default", "math", "project", "teach"];

describe("public Home experiment settings", () => {
  it("parses id:weight entries, with weight 1 for a bare id", () => {
    expect(
      parsePublicHomeExperimentArms("default:2, math, project:0.5", known),
    ).toEqual([
      { id: "default", weight: 2 },
      { id: "math", weight: 1 },
      { id: "project", weight: 0.5 },
    ]);
  });

  it("drops unknown ids, duplicates and non-positive or invalid weights", () => {
    expect(
      parsePublicHomeExperimentArms(
        "default, nope:3, math:0, math:2, project:-1, teach:x, teach:1, default:5",
        known,
      ),
    ).toEqual([
      { id: "default", weight: 1 },
      { id: "math", weight: 2 },
      { id: "teach", weight: 1 },
    ]);
  });

  it("is off with fewer than two arms, or anything but a string", () => {
    expect(parsePublicHomeExperimentArms("", known)).toEqual([]);
    expect(parsePublicHomeExperimentArms("math:3", known)).toEqual([]);
    expect(parsePublicHomeExperimentArms(undefined, known)).toEqual([]);
    expect(parsePublicHomeExperimentArms(["default", "math"], known)).toEqual(
      [],
    );
  });

  it("is off with only the built-in versions, until others exist", () => {
    expect(PUBLIC_HOME_VARIANTS).toContain("default");
    expect(parsePublicHomeExperimentArms("default, math:1, project:1")).toEqual(
      [],
    );
  });

  it("validates ids and events", () => {
    expect(isPublicHomeVariantId("math", known)).toBe(true);
    expect(isPublicHomeVariantId("Math", known)).toBe(false);
    expect(isPublicHomeVariantId("x".repeat(40), [..."x".repeat(40)])).toBe(
      false,
    );
    expect(isPublicHomeVariantId(1, known)).toBe(false);
    expect(isPublicHomeExperimentEvent("view")).toBe(true);
    expect(isPublicHomeExperimentEvent("cta")).toBe(true);
    expect(isPublicHomeExperimentEvent("signup")).toBe(true);
    expect(isPublicHomeExperimentEvent("purchase")).toBe(false);
  });
});

describe("pickPublicHomeVariant", () => {
  const arms = [
    { id: "default", weight: 2 },
    { id: "math", weight: 1 },
    { id: "project", weight: 1 },
  ];

  it("picks in proportion to the weights", () => {
    expect(pickPublicHomeVariant(arms, 0)).toBe("default");
    expect(pickPublicHomeVariant(arms, 0.49)).toBe("default");
    expect(pickPublicHomeVariant(arms, 0.5)).toBe("math");
    expect(pickPublicHomeVariant(arms, 0.74)).toBe("math");
    expect(pickPublicHomeVariant(arms, 0.75)).toBe("project");
    expect(pickPublicHomeVariant(arms, 0.999999)).toBe("project");
  });

  it("clamps out-of-range random numbers, and defaults without arms", () => {
    expect(pickPublicHomeVariant(arms, -1)).toBe("default");
    expect(pickPublicHomeVariant(arms, 1)).toBe("project");
    expect(pickPublicHomeVariant([], 0.3)).toBe("default");
  });

  it("splits a large sample close to the weights", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const id = pickPublicHomeVariant(arms, (i + 0.5) / 4000);
      counts[id] = (counts[id] ?? 0) + 1;
    }
    expect(counts).toEqual({ default: 2000, math: 1000, project: 1000 });
  });
});

describe("withPublicHomeVariant", () => {
  it("adds the version to a link, keeping its query and fragment", () => {
    expect(withPublicHomeVariant("auth/sign-up", "math")).toBe(
      "auth/sign-up?home=math",
    );
    expect(withPublicHomeVariant("auth/sign-up?x=1#top", "math")).toBe(
      "auth/sign-up?x=1&home=math#top",
    );
  });
});
