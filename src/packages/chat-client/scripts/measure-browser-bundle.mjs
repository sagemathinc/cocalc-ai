#!/usr/bin/env node
/*
 * This file is part of CoCalc: Copyright (c) 2026 SageMath, Inc.
 * License: MS-RSL - see LICENSE.md for details.
 */

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

const packageRoot = resolve(import.meta.dirname, "..");
const packagesRoot = resolve(packageRoot, "..");
const chatClientRequire = createRequire(resolve(packageRoot, "package.json"));
const syncRequire = createRequire(resolve(packagesRoot, "sync/package.json"));
const staticRequire = createRequire(
  resolve(packagesRoot, "static/package.json"),
);
const { ProvidePlugin, rspack } = staticRequire("@rspack/core");

const entries = {
  patchflow: `
    import { Session } from ${JSON.stringify(syncRequire.resolve("patchflow"))};
    globalThis.__cocalcBundleMeasure = Session;
  `,
  conat: `
    import { connect } from ${JSON.stringify(chatClientRequire.resolve("@cocalc/conat/core/client"))};
    globalThis.__cocalcBundleMeasure = connect;
  `,
  "conat-immerdb": `
    import { immerdb } from ${JSON.stringify(chatClientRequire.resolve("@cocalc/conat/sync-doc/immer-db"))};
    globalThis.__cocalcBundleMeasure = immerdb;
  `,
  "headless-chat": `
    import {
      AgentSessionIndex,
      createHeadlessChatClient,
    } from ${JSON.stringify(chatClientRequire.resolve("@cocalc/chat-client"))};
    globalThis.__cocalcBundleMeasure = {
      AgentSessionIndex,
      createHeadlessChatClient,
    };
  `,
};

function compile(config) {
  return new Promise((resolveCompile, reject) => {
    rspack(config, (error, stats) => {
      if (error) {
        reject(error);
        return;
      }
      if (stats?.hasErrors()) {
        reject(new Error(stats.toString({ all: false, errors: true })));
        return;
      }
      resolveCompile();
    });
  });
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

const workspace = mkdtempSync(join(tmpdir(), "cocalc-chat-bundle-"));
try {
  const results = [];
  for (const [name, source] of Object.entries(entries)) {
    const entry = join(workspace, `${name}.mjs`);
    const output = join(workspace, name);
    writeFileSync(entry, source);
    await compile({
      mode: "production",
      target: ["web", "es2020"],
      entry,
      output: { path: output, filename: "bundle.js" },
      optimization: {
        minimize: true,
        splitChunks: false,
      },
      resolve: {
        extensions: [".js", ".json"],
        modules: [resolve(packagesRoot, "node_modules"), "node_modules"],
        symlinks: true,
        fallback: {
          assert: staticRequire.resolve("assert/"),
          buffer: staticRequire.resolve("buffer/"),
          fs: false,
          path: staticRequire.resolve("path-browserify"),
          stream: staticRequire.resolve("stream-browserify"),
          util: staticRequire.resolve("util/"),
        },
      },
      plugins: [
        new ProvidePlugin({
          Buffer: ["buffer", "Buffer"],
        }),
      ],
      performance: { hints: false },
    });
    const bundle = readFileSync(join(output, "bundle.js"));
    results.push({
      name,
      raw: bundle.byteLength,
      gzip: gzipSync(bundle, { level: 9 }).byteLength,
      brotli: brotliCompressSync(bundle).byteLength,
    });
  }

  console.table(
    results.map(({ name, raw, gzip, brotli }) => ({
      bundle: name,
      raw: kib(raw),
      gzip: kib(gzip),
      brotli: kib(brotli),
    })),
  );
} finally {
  rmSync(workspace, { force: true, recursive: true });
}
