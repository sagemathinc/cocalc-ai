const http = require("http");
const path = require("path");
const fs = require("fs/promises");
const esbuild = require("esbuild");

const port = Number(process.env.SLATE_PW_PORT || 4172);
const rootDir = __dirname;
const distDir = path.join(rootDir, "dist");
const bundlePath = path.join(distDir, "bundle.js");
const indexPath = path.join(rootDir, "index.html");
const environmentShim = path.join(rootDir, "environment-shim.ts");
const markdownToSlateShim = path.join(rootDir, "markdown-to-slate-shim.ts");
const slateToMarkdownShim = path.join(rootDir, "slate-to-markdown-shim.ts");
const elementsTypesShim = path.join(rootDir, "elements-types-shim.tsx");
const elementsIndexShim = path.join(rootDir, "elements-index-shim.ts");
const frontendShim = path.join(rootDir, "frontend-shim.ts");
const assetsShim = path.join(rootDir, "assets-shim.ts");
const nodeBuiltinsShim = path.join(rootDir, "node-builtins-shim.ts");
const appFrameworkShim = path.join(rootDir, "app-framework-shim.ts");
const editorButtonBarShim = path.join(rootDir, "editor-button-bar-shim.ts");
const i18nShim = path.join(rootDir, "i18n-shim.ts");
const pathShim = path.join(rootDir, "path-shim.ts");
const frameContextShim = path.join(rootDir, "frame-context-shim.ts");
const codeEditorConstShim = path.join(rootDir, "code-editor-const-shim.ts");
const linkEditableShim = path.join(rootDir, "link-editable-shim.ts");
const detectLanguageShim = path.join(rootDir, "detect-language-shim.ts");

const shimPlugin = {
  name: "slate-shims",
  setup(build) {
    build.onResolve({ filter: new RegExp("utils[/\\\\]environment$") }, () => {
      return { path: environmentShim };
    });
    build.onResolve({ filter: /markdown-to-slate$/ }, () => {
      return { path: markdownToSlateShim };
    });
    build.onResolve({ filter: /slate-to-markdown$/ }, () => {
      return { path: slateToMarkdownShim };
    });
    build.onResolve({ filter: /elements[\\/]+types$/ }, () => {
      return { path: elementsTypesShim };
    });
    build.onResolve({ filter: /[\\/]+elements$/ }, () => {
      return { path: elementsIndexShim };
    });
    build.onResolve(
      { filter: /^@cocalc\/frontend\/app-framework$/ },
      () => ({ path: appFrameworkShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/editors\/editor-button-bar$/ },
      () => ({ path: editorButtonBarShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/i18n$/ },
      () => ({ path: i18nShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/frame-editors\/frame-tree\/path$/ },
      () => ({ path: pathShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/frame-editors\/frame-tree\/frame-context$/ },
      () => ({ path: frameContextShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/frame-editors\/code-editor\/const$/ },
      () => ({ path: codeEditorConstShim }),
    );
    build.onResolve({ filter: /elements[\\/]+link[\\/]+editable$/ }, () => ({
      path: linkEditableShim,
    }));
    build.onResolve(
      { filter: /^@cocalc\/frontend\/misc\/detect-language$/ },
      () => ({ path: detectLanguageShim }),
    );
    build.onResolve({ filter: /^@cocalc\/frontend$/ }, () => ({
      path: frontendShim,
    }));
    build.onResolve({ filter: /^@cocalc\/frontend\// }, () => ({
      path: frontendShim,
    }));
    build.onResolve({ filter: /^@cocalc\/assets\// }, () => ({
      path: assetsShim,
    }));
    build.onResolve({ filter: /^(path|stream)$/ }, () => ({
      path: nodeBuiltinsShim,
    }));
  },
};

async function buildHarness() {
  await fs.mkdir(distDir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(rootDir, "harness.tsx")],
    bundle: true,
    outfile: bundlePath,
    format: "esm",
    platform: "browser",
    sourcemap: "inline",
    target: ["es2019"],
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"test"',
    },
    plugins: [shimPlugin],
  });
}

function send(res, status, body, contentType) {
  res.statusCode = status;
  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }
  res.end(body);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = await fs.readFile(indexPath);
    return send(res, 200, html, "text/html; charset=utf-8");
  }

  if (url.pathname === "/bundle.js") {
    const js = await fs.readFile(bundlePath);
    return send(res, 200, js, "text/javascript; charset=utf-8");
  }

  return send(res, 404, "Not Found", "text/plain; charset=utf-8");
}

async function start() {
  try {
    await buildHarness();
  } catch (err) {
    console.error("Failed to build Slate harness", err);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Harness server error", err);
      send(res, 500, "Internal Server Error", "text/plain; charset=utf-8");
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Slate harness running at http://127.0.0.1:${port}`);
  });
}

start();
