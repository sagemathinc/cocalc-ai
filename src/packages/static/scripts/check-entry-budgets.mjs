#!/usr/bin/env node

import { readFileSync, statSync } from "fs";
import { gzipSync } from "zlib";
import { resolve, dirname } from "path";

const DIST = resolve(process.cwd(), "dist");
const KiB = 1024;
const MiB = 1024 * KiB;

const budgets = [
  {
    html: "app.html",
    maxRawBytes: 10 * MiB,
    maxGzipBytes: 2800 * KiB,
  },
  {
    html: "embed.html",
    maxRawBytes: 10 * MiB,
    maxGzipBytes: 2800 * KiB,
  },
  {
    html: "public-viewer.html",
    maxRawBytes: 700 * KiB,
    maxGzipBytes: 220 * KiB,
  },
  {
    html: "public-viewer-md.html",
    maxRawBytes: 2 * MiB,
    maxGzipBytes: 650 * KiB,
  },
  {
    html: "public-viewer-ipynb.html",
    maxRawBytes: 2 * MiB,
    maxGzipBytes: 650 * KiB,
  },
  {
    html: "public-viewer-board.html",
    maxRawBytes: 2700 * KiB,
    maxGzipBytes: 850 * KiB,
  },
  {
    html: "public-viewer-slides.html",
    maxRawBytes: 2700 * KiB,
    maxGzipBytes: 850 * KiB,
  },
  {
    html: "public-viewer-chat.html",
    maxRawBytes: 2 * MiB,
    maxGzipBytes: 650 * KiB,
  },
  {
    html: "public-home.html",
    maxRawBytes: 850 * KiB,
    maxGzipBytes: 280 * KiB,
  },
  {
    html: "public-auth.html",
    maxRawBytes: 1300 * KiB,
    maxGzipBytes: 430 * KiB,
  },
  {
    html: "public-support.html",
    maxRawBytes: 850 * KiB,
    maxGzipBytes: 280 * KiB,
  },
  {
    html: "public-content.html",
    maxRawBytes: 3200 * KiB,
    maxGzipBytes: 1000 * KiB,
  },
  {
    html: "public-lang.html",
    maxRawBytes: 1800 * KiB,
    maxGzipBytes: 600 * KiB,
  },
  {
    html: "public-features.html",
    maxRawBytes: 1300 * KiB,
    maxGzipBytes: 430 * KiB,
  },
];

function parseAssetsFromHtml(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  const assets = new Set();
  const pattern = /(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g;
  let match;
  while ((match = pattern.exec(html)) != null) {
    const ref = match[1].replace(/\?.*$/, "");
    if (ref.startsWith("http://") || ref.startsWith("https://")) continue;
    assets.add(resolve(dirname(htmlPath), ref.replace(/^\//, "")));
  }
  return [...assets];
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

let failed = false;

for (const budget of budgets) {
  const htmlPath = resolve(DIST, budget.html);
  const assets = parseAssetsFromHtml(htmlPath);
  const totalRaw = assets.reduce((sum, path) => sum + statSync(path).size, 0);
  const totalGzip = assets.reduce(
    (sum, path) => sum + gzipSync(readFileSync(path)).length,
    0,
  );
  const label = budget.html.replace(/\.html$/, "");
  const rawBudgetLabel =
    budget.maxRawBytes == null ? "n/a" : formatBytes(budget.maxRawBytes);
  console.log(
    `${label}: raw=${formatBytes(totalRaw)} gzip=${formatBytes(totalGzip)} raw-limit=${rawBudgetLabel} gzip-limit=${formatBytes(budget.maxGzipBytes)}`,
  );
  if (budget.maxRawBytes != null && totalRaw > budget.maxRawBytes) {
    failed = true;
    console.error(
      `${label}: raw bundle budget exceeded by ${formatBytes(totalRaw - budget.maxRawBytes)}`,
    );
  }
  if (totalGzip > budget.maxGzipBytes) {
    failed = true;
    console.error(
      `${label}: bundle budget exceeded by ${formatBytes(totalGzip - budget.maxGzipBytes)}`,
    );
  }
}

if (failed) {
  process.exit(1);
}
