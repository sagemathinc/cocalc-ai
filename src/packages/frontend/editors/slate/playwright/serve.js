const http = require("http");
const path = require("path");
const fs = require("fs/promises");
const esbuild = require("esbuild");

const port = Number(process.env.SLATE_PW_PORT || 4172);
const rootDir = __dirname;
const distDir = path.join(rootDir, "dist");
const bundlePath = path.join(distDir, "bundle.js");
const indexPath = path.join(rootDir, "index.html");
const autoFormatShim = path.join(rootDir, "auto-format-shim.ts");
const environmentShim = path.join(rootDir, "environment-shim.ts");

const shimPlugin = {
  name: "slate-shims",
  setup(build) {
    build.onResolve({ filter: /auto-format$/ }, (args) => {
      if (args.path.endsWith("format/auto-format")) {
        return { path: autoFormatShim };
      }
      return null;
    });
    build.onResolve({ filter: new RegExp("utils[/\\\\]environment$") }, () => {
      return { path: environmentShim };
    });
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
