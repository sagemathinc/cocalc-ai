/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  activeUsersMapAssetUrl,
  activeUsersMapRegionAssetUrl,
  projectActiveUserMapPosition,
} from "./active-users-map-geometry";

describe("active users map asset", () => {
  it("resolves below the application base path", () => {
    expect(activeUsersMapAssetUrl("/")).toBe(
      "/public/admin/active-users-world-map-equal-earth-v2.svg",
    );
    expect(activeUsersMapAssetUrl("/cocalc")).toBe(
      "/cocalc/public/admin/active-users-world-map-equal-earth-v2.svg",
    );
    expect(activeUsersMapRegionAssetUrl("/cocalc")).toBe(
      "/cocalc/public/admin/active-users-world-map-regions-equal-earth-v1.svg",
    );
  });
});

describe("active users map projection", () => {
  it("projects the equator to the vertical center", () => {
    expect(projectActiveUserMapPosition({ latitude: 0, longitude: 0 })).toEqual(
      { left: 50, top: 50 },
    );
  });

  it("places coordinates using the Equal Earth projection", () => {
    const position = projectActiveUserMapPosition({
      latitude: 34.05,
      longitude: -111.09,
    });
    expect(position.left).toBeCloseTo(22.27, 1);
    expect(position.top).toBeCloseTo(25.81, 1);
  });

  it("places representative southern-hemisphere coordinates", () => {
    const southAmerica = projectActiveUserMapPosition({
      latitude: -33.5,
      longitude: -64.17,
    });
    const australia = projectActiveUserMapPosition({
      latitude: -24.13,
      longitude: 134.05,
    });
    expect(southAmerica.left).toBeCloseTo(33.93, 1);
    expect(southAmerica.top).toBeCloseTo(73.82, 1);
    expect(australia.left).toBeCloseTo(84.96, 1);
    expect(australia.top).toBeCloseTo(67.42, 1);
  });

  it("clamps coordinates to the finite map outline", () => {
    const position = projectActiveUserMapPosition({
      latitude: 100,
      longitude: 200,
    });
    expect(position.left).toBeCloseTo(79.03, 1);
    expect(position.top).toBeCloseTo(2.3, 1);
  });
});
