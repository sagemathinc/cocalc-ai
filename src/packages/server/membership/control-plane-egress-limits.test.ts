/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  DEFAULT_CONTROL_PLANE_EGRESS_5H_BYTES,
  DEFAULT_CONTROL_PLANE_EGRESS_7D_BYTES,
  getControlPlaneEgressLimitsFromEffective,
} from "./control-plane-egress-limits";

describe("getControlPlaneEgressLimitsFromEffective", () => {
  afterEach(() => {
    delete process.env.COCALC_CONTROL_PLANE_EGRESS_7D_BYTES;
  });

  it("uses the site default when unset", () => {
    expect(getControlPlaneEgressLimitsFromEffective({})).toEqual({
      egress_5h_bytes: DEFAULT_CONTROL_PLANE_EGRESS_5H_BYTES,
      egress_7d_bytes: DEFAULT_CONTROL_PLANE_EGRESS_7D_BYTES,
    });
    process.env.COCALC_CONTROL_PLANE_EGRESS_7D_BYTES = "123";
    expect(
      getControlPlaneEgressLimitsFromEffective(undefined).egress_7d_bytes,
    ).toBe(123);
  });

  it("honors overrides, including 0, like other entitlement overrides", () => {
    expect(
      getControlPlaneEgressLimitsFromEffective({
        control_plane_egress_5h_bytes: 0,
        control_plane_egress_7d_bytes: 200_000_000_000,
      }),
    ).toEqual({ egress_5h_bytes: 0, egress_7d_bytes: 200_000_000_000 });
  });
});
