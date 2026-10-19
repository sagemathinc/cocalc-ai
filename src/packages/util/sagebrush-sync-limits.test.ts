/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  assertValidSagebrushSyncLimits,
  sagebrushSafeInteger,
  SAGEBRUSH_SYNC_INTEGER_LIMITS,
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

describe("Sagebrush sync limits", () => {
  it("accepts exactly the non-negative safe integers", () => {
    expect(sagebrushSafeInteger(0)).toBe(0);
    expect(sagebrushSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const value of BAD)
      expect(sagebrushSafeInteger(value)).toBeUndefined();
  });

  it("refuses a tier that sets a sync limit Sagebrush can't read", () => {
    for (const key of SAGEBRUSH_SYNC_INTEGER_LIMITS) {
      for (const value of BAD) {
        expect(() => assertValidSagebrushSyncLimits({ [key]: value })).toThrow(
          `usage_limits.${key}`,
        );
      }
      expect(() =>
        assertValidSagebrushSyncLimits({ [key]: Number.MAX_SAFE_INTEGER }),
      ).not.toThrow();
    }
    expect(() =>
      assertValidSagebrushSyncLimits({ sagebrush_sync_enabled: "yes" }),
    ).toThrow("sagebrush_sync_enabled");
  });

  it("allows blank limits, which are inherited", () => {
    expect(() => assertValidSagebrushSyncLimits(undefined)).not.toThrow();
    expect(() =>
      assertValidSagebrushSyncLimits({
        sagebrush_sync_enabled: null,
        sagebrush_sync_version_bytes: null,
        sagebrush_storage_bytes: 1.5,
      }),
    ).not.toThrow();
  });
});
