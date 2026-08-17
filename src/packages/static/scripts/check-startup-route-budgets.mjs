#!/usr/bin/env node

import { readFileSync } from "fs";
import { resolve } from "path";

const OUTPUT_DIR = resolve(
  process.cwd(),
  process.env.COCALC_OUTPUT || "dist-prod-measure",
);
const STATS_PATH = resolve(OUTPUT_DIR, "chunk-stats.json");
const KiB = 1024;
const MiB = 1024 * KiB;

const routes = [
  {
    label: "signed-in projects",
    request: "@cocalc/frontend/projects/projects-page",
    maxRawBytes: 6.4 * MiB,
    maxGzipBytes: 1840 * KiB,
  },
  {
    label: "signed-in project reduced",
    request: "@cocalc/frontend/project/page/reduced-page",
    maxRawBytes: 5.3 * MiB,
    maxGzipBytes: 1450 * KiB,
  },
  {
    label: "signed-in project full",
    request: "@cocalc/frontend/project/page/page",
    extraGroups: [
      {
        moduleSuffix: "frontend/app-framework/project-runtime.ts",
        request: "../project/redux/store",
      },
    ],
    maxRawBytes: 11.4 * MiB,
    maxGzipBytes: 3200 * KiB,
  },
];

const entryBudgets = [
  {
    chunk: "app",
    label: "signed-in app bootstrap",
    maxRawBytes: 3.6 * MiB,
    maxGzipBytes: 940 * KiB,
  },
];

const { chunks, groups } = JSON.parse(readFileSync(STATS_PATH, "utf8"));

function findGroup(moduleSuffix, request) {
  const matches = groups.filter((group) =>
    group.origins?.some(
      (origin) =>
        origin.module?.endsWith(moduleSuffix) && origin.request === request,
    ),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one chunk group for ${moduleSuffix} -> ${request}; found ${matches.length}`,
    );
  }
  return matches[0];
}

function collectAssets(chunkKeys) {
  const assets = new Map();
  for (const chunkKey of chunkKeys) {
    const chunk = chunks[chunkKey];
    if (chunk == null) {
      throw new Error(`missing chunk stats for ${chunkKey}`);
    }
    for (const asset of chunk.assets ?? []) {
      assets.set(asset.file, asset);
    }
  }
  return [...assets.values()];
}

function formatBytes(bytes) {
  return `${(bytes / KiB).toFixed(1)} KiB`;
}

const shellGroup = findGroup("frontend/app/render.tsx", "./page");
let failed = false;
const report = {};

for (const budget of entryBudgets) {
  const assets = collectAssets([budget.chunk]);
  const totals = assets.reduce(
    (sum, asset) => ({
      brotliBytes: sum.brotliBytes + asset.brotliBytes,
      gzipBytes: sum.gzipBytes + asset.gzipBytes,
      rawBytes: sum.rawBytes + asset.rawBytes,
    }),
    { brotliBytes: 0, gzipBytes: 0, rawBytes: 0 },
  );
  report[budget.label] = {
    assets: assets.map(({ file }) => file).sort(),
    ...totals,
  };
  console.log(
    `${budget.label}: raw=${formatBytes(totals.rawBytes)} gzip=${formatBytes(totals.gzipBytes)} brotli=${formatBytes(totals.brotliBytes)} assets=${assets.length}`,
  );
  if (process.argv.includes("--report-only")) continue;
  if (totals.rawBytes > budget.maxRawBytes) {
    failed = true;
    console.error(
      `${budget.label}: raw budget exceeded by ${formatBytes(totals.rawBytes - budget.maxRawBytes)}`,
    );
  }
  if (totals.gzipBytes > budget.maxGzipBytes) {
    failed = true;
    console.error(
      `${budget.label}: gzip budget exceeded by ${formatBytes(totals.gzipBytes - budget.maxGzipBytes)}`,
    );
  }
}

for (const route of routes) {
  const routeGroup = findGroup(
    "frontend/app/route-components.ts",
    route.request,
  );
  const extraGroups = (route.extraGroups ?? []).map((group) =>
    findGroup(group.moduleSuffix, group.request),
  );
  const chunkKeys = new Set([
    "load",
    "app",
    ...shellGroup.chunks,
    ...routeGroup.chunks,
    ...extraGroups.flatMap((group) => group.chunks),
  ]);
  const assets = collectAssets(chunkKeys);
  const totals = assets.reduce(
    (sum, asset) => ({
      brotliBytes: sum.brotliBytes + asset.brotliBytes,
      gzipBytes: sum.gzipBytes + asset.gzipBytes,
      rawBytes: sum.rawBytes + asset.rawBytes,
    }),
    { brotliBytes: 0, gzipBytes: 0, rawBytes: 0 },
  );
  report[route.label] = {
    assets: assets.map(({ file }) => file).sort(),
    ...totals,
  };
  console.log(
    `${route.label}: raw=${formatBytes(totals.rawBytes)} gzip=${formatBytes(totals.gzipBytes)} brotli=${formatBytes(totals.brotliBytes)} assets=${assets.length}`,
  );
  if (process.argv.includes("--report-only")) continue;
  if (totals.rawBytes > route.maxRawBytes) {
    failed = true;
    console.error(
      `${route.label}: raw startup route budget exceeded by ${formatBytes(totals.rawBytes - route.maxRawBytes)}`,
    );
  }
  if (totals.gzipBytes > route.maxGzipBytes) {
    failed = true;
    console.error(
      `${route.label}: gzip startup route budget exceeded by ${formatBytes(totals.gzipBytes - route.maxGzipBytes)}`,
    );
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
}

if (failed) {
  process.exit(1);
}
