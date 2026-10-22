/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  assertValidSagebrushLimits,
  sagebrushSafeInteger,
  SAGEBRUSH_BOOLEAN_LIMITS,
  SAGEBRUSH_INTEGER_LIMITS,
} from "./sagebrush-sync-limits";

const BAD = [
  Number.MAX_SAFE_INTEGER + 1,
  1e20,
  Infinity,
  -Infinity,
  NaN,
  -1,
  1.5,
  "5",
  true,
];

describe("Sagebrush limits", () => {
  it("accepts exactly the non-negative safe integers", () => {
    expect(sagebrushSafeInteger(0)).toBe(0);
    expect(sagebrushSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const value of BAD)
      expect(sagebrushSafeInteger(value)).toBeUndefined();
  });

  it("refuses a tier that sets a sync limit Sagebrush can't read", () => {
    for (const key of SAGEBRUSH_INTEGER_LIMITS) {
      for (const value of BAD) {
        expect(() => assertValidSagebrushLimits({ [key]: value })).toThrow(
          `usage_limits.${key}`,
        );
      }
      expect(() =>
        assertValidSagebrushLimits({ [key]: Number.MAX_SAFE_INTEGER }),
      ).not.toThrow();
    }
    for (const key of SAGEBRUSH_BOOLEAN_LIMITS) {
      expect(() => assertValidSagebrushLimits({ [key]: "yes" })).toThrow(
        `usage_limits.${key}`,
      );
    }
    expect(SAGEBRUSH_INTEGER_LIMITS).toContain("sagebrush_storage_bytes");
    expect(SAGEBRUSH_INTEGER_LIMITS).toContain("sagebrush_max_file_bytes");
  });

  it("allows blank limits, which are inherited", () => {
    expect(() => assertValidSagebrushLimits(undefined)).not.toThrow();
    expect(() =>
      assertValidSagebrushLimits({
        sagebrush_sync_enabled: null,
        sagebrush_sync_version_bytes: null,
        sagebrush_storage_bytes: undefined,
        max_projects: 1.5,
      }),
    ).not.toThrow();
  });
});
