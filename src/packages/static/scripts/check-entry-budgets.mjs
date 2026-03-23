#!/usr/bin/env node

import { readFileSync, statSync } from "fs";
import { gzipSync } from "zlib";
import { resolve, dirname } from "path";

const DIST = resolve(process.cwd(), "dist");

const budgets = [
  {
    html: "public-auth.html",
    maxGzipBytes: 250 * 1024,
  },
  {
    html: "public-support.html",
    maxGzipBytes: 250 * 1024,
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
  console.log(
    `${label}: raw=${formatBytes(totalRaw)} gzip=${formatBytes(totalGzip)} limit=${formatBytes(budget.maxGzipBytes)}`,
  );
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
