/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

const EQUAL_EARTH_A1 = 1.340264;
const EQUAL_EARTH_A2 = -0.081106;
const EQUAL_EARTH_A3 = 0.000893;
const EQUAL_EARTH_A4 = 0.003796;
const EQUAL_EARTH_M = Math.sqrt(3) / 2;

export const ACTIVE_USERS_MAP = {
  assetFilename: "active-users-world-map-equal-earth-v2.svg",
  baseLayerId: "active-users-map-base",
  height: 800,
  padding: 16,
  projection: "Equal Earth",
  regionAssetFilename: "active-users-world-map-regions-equal-earth-v1.svg",
  regionLayerId: "active-users-map-regions",
  width: 1600,
} as const;

export function activeUsersMapAssetUrl(basePath = appBasePath): string {
  return joinUrlPath(basePath, "public/admin", ACTIVE_USERS_MAP.assetFilename);
}

export const ACTIVE_USERS_MAP_ASSET_URL = activeUsersMapAssetUrl();

export function activeUsersMapRegionAssetUrl(basePath = appBasePath): string {
  return joinUrlPath(
    basePath,
    "public/admin",
    ACTIVE_USERS_MAP.regionAssetFilename,
  );
}

export const ACTIVE_USERS_MAP_REGION_ASSET_URL = activeUsersMapRegionAssetUrl();

function projectEqualEarthRaw({
  latitude,
  longitude,
}: {
  latitude: number;
  longitude: number;
}): { x: number; y: number } {
  const lambda = (longitude * Math.PI) / 180;
  const phi = (latitude * Math.PI) / 180;
  const theta = Math.asin(EQUAL_EARTH_M * Math.sin(phi));
  const theta2 = theta * theta;
  const theta6 = theta2 * theta2 * theta2;
  return {
    x:
      (lambda * Math.cos(theta)) /
      (EQUAL_EARTH_M *
        (EQUAL_EARTH_A1 +
          3 * EQUAL_EARTH_A2 * theta2 +
          theta6 * (7 * EQUAL_EARTH_A3 + 9 * EQUAL_EARTH_A4 * theta2))),
    y:
      theta *
      (EQUAL_EARTH_A1 +
        EQUAL_EARTH_A2 * theta2 +
        theta6 * (EQUAL_EARTH_A3 + EQUAL_EARTH_A4 * theta2)),
  };
}

const EQUAL_EARTH_X_EXTENT = projectEqualEarthRaw({
  latitude: 0,
  longitude: 180,
}).x;
const EQUAL_EARTH_Y_EXTENT = projectEqualEarthRaw({
  latitude: 90,
  longitude: 0,
}).y;
const ACTIVE_USERS_MAP_SCALE = Math.min(
  (ACTIVE_USERS_MAP.width - 2 * ACTIVE_USERS_MAP.padding) /
    (2 * EQUAL_EARTH_X_EXTENT),
  (ACTIVE_USERS_MAP.height - 2 * ACTIVE_USERS_MAP.padding) /
    (2 * EQUAL_EARTH_Y_EXTENT),
);

export function projectActiveUserMapPoint({
  latitude,
  longitude,
}: {
  latitude: number;
  longitude: number;
}): { x: number; y: number } {
  const point = projectEqualEarthRaw({
    latitude: Math.min(90, Math.max(-90, latitude)),
    longitude: Math.min(180, Math.max(-180, longitude)),
  });
  return {
    x: ACTIVE_USERS_MAP.width / 2 + point.x * ACTIVE_USERS_MAP_SCALE,
    y: ACTIVE_USERS_MAP.height / 2 - point.y * ACTIVE_USERS_MAP_SCALE,
  };
}

export function projectActiveUserMapPosition({
  latitude,
  longitude,
}: {
  latitude: number;
  longitude: number;
}): { left: number; top: number } {
  const point = projectActiveUserMapPoint({ latitude, longitude });
  return {
    left: (point.x / ACTIVE_USERS_MAP.width) * 100,
    top: (point.y / ACTIVE_USERS_MAP.height) * 100,
  };
}
