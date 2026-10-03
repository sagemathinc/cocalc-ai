const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const esbuild = require("esbuild");

const port = Number(process.env.CHAT_PW_PORT || 4173);
const rootDir = __dirname;
const repoFrontendDir = path.join(rootDir, "..", "..");
const slatePlaywrightDir = path.join(
  repoFrontendDir,
  "editors",
  "slate",
  "playwright",
);
const distDir = path.join(os.tmpdir(), "cocalc-chat-playwright-dist");
const bundlePath = path.join(distDir, "bundle.js");
const switchBundlePath = path.join(distDir, "switch-bundle.js");
const indexPath = path.join(rootDir, "index.html");

const appFrameworkShim = path.join(rootDir, "app-framework-shim.ts");
const miscShim = path.join(rootDir, "misc-shim.ts");
const featureShim = path.join(rootDir, "feature-shim.ts");
const intlShim = path.join(rootDir, "intl-shim.tsx");
const mentionableUsersShim = path.join(rootDir, "mentionable-users-shim.ts");
const mentionsShim = path.join(rootDir, "mentions-shim.ts");

const environmentShim = path.join(slatePlaywrightDir, "environment-shim.ts");
const markdownToSlateShim = path.join(
  slatePlaywrightDir,
  "markdown-to-slate-shim.ts",
);
const slateToMarkdownShim = path.join(
  slatePlaywrightDir,
  "slate-to-markdown-shim.ts",
);
const elementsTypesShim = path.join(
  slatePlaywrightDir,
  "elements-types-shim.tsx",
);
const elementsIndexShim = path.join(
  slatePlaywrightDir,
  "elements-index-shim.ts",
);
const frontendShim = path.join(rootDir, "frontend-shim.tsx");
const assetsShim = path.join(slatePlaywrightDir, "assets-shim.ts");
const nodeBuiltinsShim = path.join(slatePlaywrightDir, "node-builtins-shim.ts");
const editorButtonBarShim = path.join(
  slatePlaywrightDir,
  "editor-button-bar-shim.ts",
);
const frameContextShim = path.join(rootDir, "frame-context-shim.ts");
const composerServicesShim = path.join(rootDir, "composer-services-shim.tsx");
const codeEditorConstShim = path.join(
  slatePlaywrightDir,
  "code-editor-const-shim.ts",
);
const linkEditableShim = path.join(slatePlaywrightDir, "link-editable-shim.ts");
const detectLanguageShim = path.join(
  slatePlaywrightDir,
  "detect-language-shim.ts",
);
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
    build.onResolve(
      {
        filter:
          /^\.\/(thread-badge|codex-goal|acp-prompt-modal|codex-submit-preflight|use-codex-payment-source|audio\/dictate-button|agent-file-attachment|codex)$/,
      },
      (args) =>
        args.importer.endsWith(`${path.sep}chat${path.sep}composer.tsx`)
          ? { path: composerServicesShim }
          : undefined,
    );
    build.onResolve(
      {
        filter: /^@cocalc\/frontend\/agents\/(use-agent-mentions|name-agent)$/,
      },
      () => ({ path: composerServicesShim }),
    );
    build.onResolve(
      {
        filter:
          /^@cocalc\/frontend\/(agents\/(mention-context|unbound-mentions)|keyboard\/boundary)$/,
      },
      (args) => ({
        path: path.join(
          repoFrontendDir,
          args.path.replace("@cocalc/frontend/", "") +
            (args.path.endsWith("boundary") ? ".tsx" : ".ts"),
        ),
      }),
    );
    build.onResolve({ filter: new RegExp("utils[/\\\\]environment$") }, () => {
      return { path: environmentShim };
    });
    build.onResolve({ filter: /markdown-to-slate$/ }, () => ({
      path: markdownToSlateShim,
    }));
    build.onResolve({ filter: /slate-to-markdown$/ }, () => ({
      path: slateToMarkdownShim,
    }));
    build.onResolve({ filter: /elements[\\/]+types$/ }, () => ({
      path: elementsTypesShim,
    }));
    build.onResolve({ filter: /[\\/]+elements$/ }, () => ({
      path: elementsIndexShim,
    }));
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
      {
        filter:
          /^@cocalc\/frontend\/editors\/markdown-input\/mentionable-users$/,
      },
      () => ({ path: mentionableUsersShim }),
    );
    build.onResolve(
      { filter: /^@cocalc\/frontend\/editors\/markdown-input\/mentions$/ },
      () => ({ path: mentionsShim }),
    );
    build.onResolve({ filter: /mentionable-users$/ }, (args) => {
      if (
        args.importer.includes(
          `${path.sep}editors${path.sep}markdown-input${path.sep}component.tsx`,
        ) &&
        args.path.startsWith(".")
      ) {
        return { path: mentionableUsersShim };
      }
    });
    build.onResolve({ filter: /mentions$/ }, (args) => {
      if (
        args.importer.includes(
          `${path.sep}editors${path.sep}markdown-input${path.sep}component.tsx`,
        ) &&
        args.path.startsWith(".")
      ) {
        return { path: mentionsShim };
      }
    });
    build.onResolve({ filter: /^@cocalc\/frontend\/app-framework$/ }, () => ({
      path: appFrameworkShim,
    }));
    build.onResolve({ filter: /^@cocalc\/frontend\/misc$/ }, () => ({
      path: miscShim,
    }));
    build.onResolve({ filter: /^@cocalc\/frontend\/feature$/ }, () => ({
      path: featureShim,
    }));
    build.onResolve({ filter: /^react-intl$/ }, () => ({ path: intlShim }));
    build.onResolve(
      {
        filter: /^@cocalc\/frontend\/frame-editors\/frame-tree\/frame-context$/,
      },
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
    build.onResolve({ filter: /^@cocalc\/frontend\/i18n$/ }, () => ({
      path: i18nShim,
    }));
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
    build.onResolve({ filter: /^@cocalc\/assets\// }, () => ({
      path: assetsShim,
    }));
    build.onResolve({ filter: /^(path|stream)$/ }, () => ({
      path: nodeBuiltinsShim,
    }));
  },
};

// Real list/scroll code for the chat switch harness; message chrome that needs
// app services is stubbed.
const chatSwitchPlugin = {
  name: "chat-switch",
  setup(build) {
    build.onResolve(
      { filter: /^@cocalc\/frontend\/editors\/slate\/static-markdown$/ },
      () => ({ path: path.join(rootDir, "static-markdown-shim.tsx") }),
    );
    build.onResolve({ filter: /^\.\/git-commit-drawer$/ }, (args) =>
      args.importer.endsWith(`${path.sep}chat${path.sep}message.tsx`)
        ? { path: path.join(rootDir, "message-parts-shim.tsx") }
        : undefined,
    );
    build.onResolve(
      {
        filter:
          /^@cocalc\/frontend\/(components\/stateful-virtuoso|jupyter\/div-temp-height)$/,
      },
      (args) => ({
        path: path.join(
          repoFrontendDir,
          args.path.replace("@cocalc/frontend/", "") + ".tsx",
        ),
      }),
    );
  },
};

// Shims model only what the composer harness needs. The full ChatLog pulls in
// many more frontend modules; missing named exports become inert stubs (after
// a failed build pass reports them) so real list/scroll behavior can be
// exercised in a browser.
const lenientStubs = new Map(); // shim path -> Set of missing export names

function lenientWrapperSource(shimPath, names) {
  const lines = [
    `import * as React from "react";`,
    `export * from ${JSON.stringify(shimPath)};`,
    `const stub = (name) => React[name] ?? function () { return undefined; };`,
  ];
  for (const name of names) {
    lines.push(
      name === "default"
        ? `export default stub("default");`
        : `export const ${name} = stub(${JSON.stringify(name)});`,
    );
  }
  return lines.join("\n");
}

const lenientPlugin = {
  name: "chat-lenient-stubs",
  setup(build) {
    build.onResolve({ filter: /.*/ }, async (args) => {
      if (args.namespace === "lenient" || args.pluginData?.lenient) return;
      if (lenientStubs.size === 0) return;
      const result = await build.resolve(args.path, {
        importer: args.importer,
        kind: args.kind,
        resolveDir: args.resolveDir,
        pluginData: { lenient: true },
      });
      if (result.errors.length > 0) return;
      if (!lenientStubs.has(result.path)) return;
      return { path: result.path, namespace: "lenient" };
    });
    build.onLoad({ filter: /.*/, namespace: "lenient" }, (args) => ({
      contents: lenientWrapperSource(args.path, lenientStubs.get(args.path)),
      loader: "js",
      resolveDir: path.dirname(args.path),
    }));
  },
};

async function buildHarness() {
  await buildBundle({ entry: "harness.tsx", outfile: bundlePath }, [
    shimPlugin,
  ]);
  await buildSwitchHarness();
}

async function buildSwitchHarness() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await buildBundle(
        {
          entry: "chat-switch-harness.tsx",
          outfile: switchBundlePath,
          logLevel: "silent",
          banner: {
            js: "globalThis.process ??= { env: {}, platform: 'browser', cwd: () => '/' };",
          },
        },
        [lenientPlugin, chatSwitchPlugin, shimPlugin],
      );
    } catch (err) {
      let added = 0;
      for (const { text } of err.errors ?? []) {
        const match =
          /No matching export in "([^"]+)" for import "([^"]+)"/.exec(text);
        if (!match) continue;
        const file = path.resolve(
          process.cwd(),
          match[1].replace(/^lenient:/, ""),
        );
        const names = lenientStubs.get(file) ?? new Set();
        if (!names.has(match[2])) {
          names.add(match[2]);
          added += 1;
        }
        lenientStubs.set(file, names);
      }
      if (added === 0) throw err;
    }
  }
  throw new Error("chat switch harness build did not converge");
}

async function buildBundle({ entry, outfile, logLevel, banner }, plugins) {
  await fs.mkdir(distDir, { recursive: true });
  await esbuild.build({
    logLevel,
    banner,
    entryPoints: [path.join(rootDir, entry)],
    bundle: true,
    outfile,
    format: "esm",
    platform: "browser",
    sourcemap: "inline",
    target: ["es2019"],
    jsx: "automatic",
    define: {
      // Ant Design uses constant IDs in test mode; a real browser needs the
      // normal ID lifecycle for popup/dialog labels and focus management.
      "process.env.NODE_ENV": '"development"',
    },
    plugins,
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
    let html = await fs.readFile(indexPath, "utf8");
    if (url.searchParams.get("mode") === "chat-switch") {
      html = html.replace(/\/bundle\.(js|css)/g, "/switch-bundle.$1");
    }
    return send(res, 200, html, "text/html; charset=utf-8");
  }
  if (url.pathname === "/bundle.js" || url.pathname === "/switch-bundle.js") {
    const js = await fs.readFile(path.join(distDir, url.pathname));
    return send(res, 200, js, "text/javascript; charset=utf-8");
  }
  if (url.pathname === "/bundle.css" || url.pathname === "/switch-bundle.css") {
    const css = await fs.readFile(path.join(distDir, url.pathname));
    return send(res, 200, css, "text/css; charset=utf-8");
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
