const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const esbuild = require("esbuild");

const port = Number(process.env.CHAT_PW_PORT || 4173);
const rootDir = __dirname;
const repoFrontendDir = path.join(rootDir, "..", "..");
const slatePlaywrightDir = path.join(repoFrontendDir, "editors", "slate", "playwright");
const distDir = path.join(os.tmpdir(), "cocalc-chat-playwright-dist");
const bundlePath = path.join(distDir, "bundle.js");
const indexPath = path.join(rootDir, "index.html");

const appFrameworkShim = path.join(rootDir, "app-framework-shim.ts");
const miscShim = path.join(rootDir, "misc-shim.ts");
const featureShim = path.join(rootDir, "feature-shim.ts");
const intlShim = path.join(rootDir, "intl-shim.tsx");
const mentionableUsersShim = path.join(rootDir, "mentionable-users-shim.ts");
const mentionsShim = path.join(rootDir, "mentions-shim.ts");

const environmentShim = path.join(slatePlaywrightDir, "environment-shim.ts");
const markdownToSlateShim = path.join(slatePlaywrightDir, "markdown-to-slate-shim.ts");
const slateToMarkdownShim = path.join(slatePlaywrightDir, "slate-to-markdown-shim.ts");
const elementsTypesShim = path.join(slatePlaywrightDir, "elements-types-shim.tsx");
const elementsIndexShim = path.join(slatePlaywrightDir, "elements-index-shim.ts");
const frontendShim = path.join(slatePlaywrightDir, "frontend-shim.ts");
const assetsShim = path.join(slatePlaywrightDir, "assets-shim.ts");
const nodeBuiltinsShim = path.join(slatePlaywrightDir, "node-builtins-shim.ts");
const editorButtonBarShim = path.join(slatePlaywrightDir, "editor-button-bar-shim.ts");
const frameContextShim = path.join(slatePlaywrightDir, "frame-context-shim.ts");
const codeEditorConstShim = path.join(slatePlaywrightDir, "code-editor-const-shim.ts");
const linkEditableShim = path.join(slatePlaywrightDir, "link-editable-shim.ts");
const detectLanguageShim = path.join(slatePlaywrightDir, "detect-language-shim.ts");
const i18nShim = path.join(slatePlaywrightDir, "i18n-shim.ts");
const pathShim = path.join(slatePlaywrightDir, "path-shim.ts");
const editableMarkdownPath = path.join(
  repoFrontendDir,
  "editors",
  "slate",
  "editable-markdown.tsx",
);
const markdownInputMultimodePath = path.join(
  repoFrontendDir,
  "editors",
  "markdown-input",
  "multimode.tsx",
);

const shimPlugin = {
  name: "chat-shims",
  setup(build) {
    build.onResolve({ filter: new RegExp("utils[/\\\\]environment$") }, () => {
      return { path: environmentShim };
    });
    build.onResolve({ filter: /markdown-to-slate$/ }, () => ({ path: markdownToSlateShim }));
    build.onResolve({ filter: /slate-to-markdown$/ }, () => ({ path: slateToMarkdownShim }));
    build.onResolve({ filter: /elements[\\/]+types$/ }, () => ({ path: elementsTypesShim }));
    build.onResolve({ filter: /[\\/]+elements$/ }, () => ({ path: elementsIndexShim }));
    build.onResolve({ filter: /elements[\\/]+link[\\/]+editable$/ }, () => ({
      path: linkEditableShim,
    }));
    build.onResolve(
      { filter: /^@cocalc\/frontend\/editors\/slate\/editable-markdown$/ },
      () => ({ path: editableMarkdownPath }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/editors\/markdown-input\/multimode$/ },
      () => ({ path: markdownInputMultimodePath }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/editors\/markdown-input\/mentionable-users$/ },
      () => ({ path: mentionableUsersShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/editors\/markdown-input\/mentions$/ },
      () => ({ path: mentionsShim }),
    );
    build.onResolve(
      { filter: /mentionable-users$/ },
      (args) => {
        if (
          args.importer.includes(`${path.sep}editors${path.sep}markdown-input${path.sep}component.tsx`) &&
          args.path.startsWith(".")
        ) {
          return { path: mentionableUsersShim };
        }
      },
    );
    build.onResolve(
      { filter: /mentions$/ },
      (args) => {
        if (
          args.importer.includes(`${path.sep}editors${path.sep}markdown-input${path.sep}component.tsx`) &&
          args.path.startsWith(".")
        ) {
          return { path: mentionsShim };
        }
      },
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/app-framework$/ },
      () => ({ path: appFrameworkShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/misc$/ },
      () => ({ path: miscShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/feature$/ },
      () => ({ path: featureShim }),
    );
    build.onResolve(
      { filter: /^react-intl$/ },
      () => ({ path: intlShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/frame-editors\/frame-tree\/frame-context$/ },
      () => ({ path: frameContextShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/frame-editors\/code-editor\/const$/ },
      () => ({ path: codeEditorConstShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/editors\/editor-button-bar$/ },
      () => ({ path: editorButtonBarShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/misc\/detect-language$/ },
      () => ({ path: detectLanguageShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/i18n$/ },
      () => ({ path: i18nShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/frame-editors\/frame-tree\/path$/ },
      () => ({ path: pathShim }),
    );
    build.onResolve({ filter: /^@cocalc\/frontend$/ }, () => ({
      path: frontendShim,
    }));
    build.onResolve({ filter: /^@cocalc\/frontend\// }, () => ({
      path: frontendShim,
    }));
    build.onResolve({ filter: /^@cocalc\/assets\// }, () => ({ path: assetsShim }));
    build.onResolve({ filter: /^(path|stream)$/ }, () => ({ path: nodeBuiltinsShim }));
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
    console.error("Failed to build chat harness", err);
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Chat harness server error", err);
      send(res, 500, "Internal Server Error", "text/plain; charset=utf-8");
    });
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Chat harness running at http://127.0.0.1:${port}`);
  });
}

start();
