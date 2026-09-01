/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { COLORS } from "../../../util/theme.ts";
import {
  ACTIVE_USERS_MAP,
  projectActiveUserMapPoint,
} from "../active-users-map-geometry.ts";

const NATURAL_EARTH_REVISION = "ca96624a56bd078437bca8184e78163e5039ad19";
const NATURAL_EARTH_ROOT = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NATURAL_EARTH_REVISION}/geojson`;
const COUNTRIES_50M_URL = `${NATURAL_EARTH_ROOT}/ne_50m_admin_0_countries.geojson`;
const MAP_UNITS_50M_URL = `${NATURAL_EARTH_ROOT}/ne_50m_admin_0_map_units.geojson`;
const REGIONS_50M_URL = `${NATURAL_EARTH_ROOT}/ne_50m_admin_1_states_provinces_lines.geojson`;

async function getGeoJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

function number(value) {
  return Number(value.toFixed(2)).toString();
}

function point([longitude, latitude]) {
  const { x, y } = projectActiveUserMapPoint({ latitude, longitude });
  return `${number(x)},${number(y)}`;
}

function linePath(coordinates, close = false) {
  if (coordinates.length === 0) return "";
  return `M${coordinates.map(point).join("L")}${close ? "Z" : ""}`;
}

function geometryPath(geometry) {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .flatMap((polygon) => polygon.map((ring) => linePath(ring, true)))
    .join("");
}

function lineGeometryPath(geometry) {
  if (geometry.type === "LineString") return linePath(geometry.coordinates);
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.map((line) => linePath(line)).join("");
  }
  throw Error(`unsupported line geometry: ${geometry.type}`);
}

function range(start, end, step) {
  const values = [];
  if (step > 0) {
    for (let value = start; value <= end; value += step) values.push(value);
  } else {
    for (let value = start; value >= end; value += step) values.push(value);
  }
  return values;
}

function globePath() {
  return linePath(
    [
      ...range(-180, 180, 2).map((longitude) => [longitude, 90]),
      ...range(88, -90, -2).map((latitude) => [180, latitude]),
      ...range(178, -180, -2).map((longitude) => [longitude, -90]),
      ...range(-88, 90, 2).map((latitude) => [-180, latitude]),
    ],
    true,
  );
}

function graticulePaths() {
  const parallels = [-60, -30, 0, 30, 60].map((latitude) =>
    linePath(range(-180, 180, 2).map((longitude) => [longitude, latitude])),
  );
  const meridians = range(-150, 150, 30).map((longitude) =>
    linePath(range(-90, 90, 2).map((latitude) => [longitude, latitude])),
  );
  return [...parallels, ...meridians];
}

function generatedHeader() {
  return `<!--
Generated from Natural Earth public-domain data at revision
${NATURAL_EARTH_REVISION}. Regenerate with:
  pnpm generate:active-users-map
-->`;
}

function renderMap(countries) {
  const countryPaths = countries.features
    .map(
      ({ geometry }) =>
        `    <path d="${geometryPath(geometry)}" fill-rule="evenodd" vector-effect="non-scaling-stroke"/>`,
    )
    .join("\n");
  const graticule = graticulePaths()
    .map((path) => `    <path d="${path}" vector-effect="non-scaling-stroke"/>`)
    .join("\n");
  return `${generatedHeader()}
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ACTIVE_USERS_MAP.width} ${ACTIVE_USERS_MAP.height}" role="img" aria-labelledby="title description" data-projection="${ACTIVE_USERS_MAP.projection}">
  <title id="title">World map</title>
  <desc id="description">An Equal Earth map generated from Natural Earth country boundaries.</desc>
  <g id="${ACTIVE_USERS_MAP.baseLayerId}">
    <path d="${globePath()}" fill="${COLORS.BLUE_LLLL}" stroke="${COLORS.BLUE_LL}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <g fill="none" opacity="0.45" stroke="${COLORS.BLUE_LL}" stroke-width="0.75">
${graticule}
    </g>
    <g fill="${COLORS.GRAY_LLL}" stroke="${COLORS.GRAY}" stroke-linejoin="round" stroke-width="2">
${countryPaths}
    </g>
  </g>
</svg>
`;
}

function renderRegionOverlay(regions) {
  const regionPaths = regions.features
    .map(
      ({ geometry }) =>
        `    <path d="${lineGeometryPath(geometry)}" vector-effect="non-scaling-stroke"/>`,
    )
    .join("\n");
  return `${generatedHeader()}
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ACTIVE_USERS_MAP.width} ${ACTIVE_USERS_MAP.height}" aria-hidden="true" data-projection="${ACTIVE_USERS_MAP.projection}">
  <g id="${ACTIVE_USERS_MAP.regionLayerId}" fill="none" opacity="0.7" stroke="${COLORS.BRWN}" stroke-linejoin="round" stroke-width="1">
${regionPaths}
  </g>
</svg>
`;
}

function addCountryLabels(labels, features) {
  for (const { properties } of features) {
    const code = `${properties.ISO_A2_EH ?? ""}`;
    const longitude = Number(properties.LABEL_X);
    const latitude = Number(properties.LABEL_Y);
    if (
      labels.has(code) ||
      !/^[A-Z]{2}$/.test(code) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude)
    ) {
      continue;
    }
    labels.set(code, { latitude, longitude });
  }
}

function renderCountryLabels(countries, mapUnits) {
  const labels = new Map();
  // Prefer one label selected for the whole country, then fill dependencies and
  // territories that Cloudflare reports separately from the map-unit dataset.
  addCountryLabels(labels, countries.features);
  addCountryLabels(labels, mapUnits.features);
  const values = [...labels.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([code, { latitude, longitude }]) =>
        `  ${code}: [${longitude}, ${latitude}],`,
    )
    .join("\n");
  return `/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 *
 *  Generated by scripts/generate-active-users-map.mjs from Natural Earth
 *  country and map-unit label coordinates. Do not edit manually.
 */

export type ActiveUsersMapCountryLabel = readonly [
  longitude: number,
  latitude: number,
];

export const ACTIVE_USERS_MAP_COUNTRY_LABELS: Readonly<
  Record<string, ActiveUsersMapCountryLabel>
> = {
${values}
};
`;
}

const [countries50m, mapUnits50m, regions50m] = await Promise.all([
  getGeoJson(COUNTRIES_50M_URL),
  getGeoJson(MAP_UNITS_50M_URL),
  getGeoJson(REGIONS_50M_URL),
]);

await Promise.all([
  writeFile(
    fileURLToPath(
      new URL(
        `../../../assets/public/admin/${ACTIVE_USERS_MAP.assetFilename}`,
        import.meta.url,
      ),
    ),
    renderMap(countries50m),
  ),
  writeFile(
    fileURLToPath(
      new URL(
        `../../../assets/public/admin/${ACTIVE_USERS_MAP.regionAssetFilename}`,
        import.meta.url,
      ),
    ),
    renderRegionOverlay(regions50m),
  ),
  writeFile(
    fileURLToPath(
      new URL("../active-users-map-country-labels.ts", import.meta.url),
    ),
    renderCountryLabels(countries50m, mapUnits50m),
  ),
]);
