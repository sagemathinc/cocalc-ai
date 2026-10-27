/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { assertNebiusSpotOffered, NEBIUS_SPOT_OFFERED } from "./nebius-spot";

describe("assertNebiusSpotOffered", () => {
  it("refuses Nebius Spot while it is not offered (#684)", () => {
    expect(NEBIUS_SPOT_OFFERED).toBe(false);
    expect(() => assertNebiusSpotOffered("nebius", "spot")).toThrow(
      /Nebius Spot is unavailable/,
    );
    expect(() => assertNebiusSpotOffered("NEBIUS", "spot")).toThrow();
  });

  it("allows everything else", () => {
    for (const [provider, pricing] of [
      ["nebius", "on_demand"],
      ["nebius", undefined],
      ["gcp", "spot"],
      [undefined, "spot"],
    ]) {
      expect(() => assertNebiusSpotOffered(provider, pricing)).not.toThrow();
    }
  });
});
