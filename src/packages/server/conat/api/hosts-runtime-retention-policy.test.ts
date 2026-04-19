/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { normalizeHostRuntimeRetentionPolicy } from "./hosts-runtime-retention-policy";

describe("normalizeHostRuntimeRetentionPolicy", () => {
  it("falls back to defaults when no configured policy is present", () => {
    expect(normalizeHostRuntimeRetentionPolicy(undefined)).toEqual({
      "project-host": { keep_count: 10 },
      "project-bundle": { keep_count: 3 },
      tools: { keep_count: 3 },
    });
  });

  it("normalizes configured keep counts and byte budgets", () => {
    expect(
      normalizeHostRuntimeRetentionPolicy({
        "project-host": { keep_count: "12", max_bytes: "4096" },
        "project-bundle": { keep_count: 4 },
        tools: { keep_count: 5, max_bytes: 2048 },
      }),
    ).toEqual({
      "project-host": { keep_count: 12, max_bytes: 4096 },
      "project-bundle": { keep_count: 4 },
      tools: { keep_count: 5, max_bytes: 2048 },
    });
  });

  it("ignores invalid configured values and preserves defaults", () => {
    expect(
      normalizeHostRuntimeRetentionPolicy({
        "project-host": { keep_count: -1, max_bytes: -5 },
        "project-bundle": { keep_count: "not-a-number" },
        tools: { keep_count: 2.9, max_bytes: "bad" },
      }),
    ).toEqual({
      "project-host": { keep_count: 10 },
      "project-bundle": { keep_count: 3 },
      tools: { keep_count: 2 },
    });
  });
});
