// Bundle frontend code for a real-browser test (Playwright), with the same
// browser polyfills, globals and "?raw" imports the app's rspack config
// provides.  `contents` is a TSX entry point resolved from the frontend
// package.  Returns the bundled JavaScript.
import { build } from "esbuild";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../", import.meta.url));

export async function bundleFrontend(contents) {
  const staticRequire = createRequire(
    fileURLToPath(new URL("../../static/package.json", import.meta.url)),
  );
  const polyfill = (name) => staticRequire.resolve(name);
  const frontendRequire = createRequire(`${frontend}package.json`);
  const injectFile = join(
    mkdtempSync(join(tmpdir(), "browser-bundle-")),
    "inject.js",
  );
  writeFileSync(
    injectFile,
    `import * as React from "${frontendRequire.resolve("react")}"; export { React }; export { Buffer } from "${polyfill("buffer/")}";`,
  );
  const result = await build({
    stdin: { resolveDir: frontend, loader: "tsx", contents },
    bundle: true,
    write: false,
    jsx: "automatic",
    platform: "browser",
    inject: [injectFile],
    alias: {
      path: polyfill("path-browserify"),
      util: polyfill("util/"),
      assert: polyfill("assert/"),
      buffer: polyfill("buffer/"),
      stream: polyfill("stream-browserify"),
      events: staticRequire.resolve("events/", {
        paths: [
          fileURLToPath(
            new URL(
              "../../node_modules/.pnpm/events@3.3.0/node_modules",
              import.meta.url,
            ),
          ),
        ],
      }),
    },
    loader: {
      ".css": "empty",
      ".svg": "dataurl",
      ".png": "dataurl",
      ".woff": "empty",
      ".woff2": "empty",
      ".ttf": "empty",
    },
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env": "{}",
      global: "window",
      DEBUG: "false",
    },
    logLevel: "error",
    plugins: [
      {
        // "file?raw" imports: the file's text, as rspack's asset/source.
        name: "raw",
        setup(b) {
          b.onResolve({ filter: /\?raw$/ }, ({ path, resolveDir }) => ({
            path: frontendRequire.resolve(path.slice(0, -"?raw".length), {
              paths: [resolveDir],
            }),
            namespace: "raw",
          }));
          b.onLoad({ filter: /.*/, namespace: "raw" }, ({ path }) => ({
            contents: readFileSync(path, "utf8"),
            loader: "text",
          }));
        },
      },
      {
        // Node-only modules some shared code imports behind runtime checks.
        name: "node-stubs",
        setup(b) {
          b.onResolve(
            { filter: /^(fs|child_process|net|tls|os|crypto|worker_threads)$/ },
            ({ path }) => ({ path, namespace: "node-stub" }),
          );
          b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
            contents: "module.exports = {};",
            loader: "js",
          }));
        },
      },
      {
        // Generated translation catalogs may not be built in a checkout.
        name: "i18n-catalogs",
        setup(b) {
          b.onResolve(
            { filter: /\/i18n\/trans\/.*\.compiled\.json$/ },
            ({ path }) => ({
              path,
              namespace: "i18n-stub",
            }),
          );
          b.onLoad({ filter: /.*/, namespace: "i18n-stub" }, () => ({
            contents: "{}",
            loader: "json",
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}
