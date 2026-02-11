import express, { type Application } from "express";
import { path as STATIC_PATH } from "@cocalc/static";
import { path as ASSET_PATH } from "@cocalc/assets";
import getPort from "@cocalc/backend/get-port";
import {
  createServer as httpCreateServer,
  type Server as HTTPServer,
} from "http";
import {
  createServer as httpsCreateServer,
  type Server as HTTPSServer,
} from "https";
import getLogger from "@cocalc/backend/logger";
import port0 from "@cocalc/backend/port";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { project_id } from "@cocalc/project/data";
import { handleFileDownload } from "@cocalc/conat/files/file-download";
import { join } from "node:path";
import initBlobUpload from "./hub/blobs/upload";
import initBlobDownload from "./hub/blobs/download";
import { account_id } from "@cocalc/backend/data";
import {
  FALLBACK_PROJECT_UUID,
  FALLBACK_ACCOUNT_UUID,
} from "@cocalc/util/misc";
import fs from "node:fs";
import { initAuth } from "./auth-token";
import { getCustomizePayload } from "./hub/settings";
import { getOrCreateSelfSigned } from "./tls";
import { attachProxyServer } from "@cocalc/project/servers/proxy/proxy";

const logger = getLogger("lite:static");

type AnyServer = HTTPServer | HTTPSServer;

export async function initHttpServer({ AUTH_TOKEN }): Promise<{
  httpServer: ReturnType<typeof httpCreateServer>;
  app: Application;
  port: number;
  isHttps: boolean;
  hostname: string;
}> {
  const app = express();

  const requestedPort =
    Number.isFinite(port0) && port0 > 0 ? port0 : await getPort();
  const hostEnv = process.env.HOST ?? "localhost";
  const { isHttps, hostname } = sanitizeHost(hostEnv);
  let httpServer: AnyServer;
  let actualPort = requestedPort;

  if (isHttps) {
    const { key, cert, keyPath, certPath } = getOrCreateSelfSigned(hostname);
    httpServer = httpsCreateServer({ key, cert }, app);
    httpServer.on("error", (err: any) => {
      logger.error(
        "*".repeat(60) +
          `\nWARNING -- hub https server error: ${err.stack || err}\n` +
          "*".repeat(60),
      );
      if (err?.code === "EADDRINUSE" || err?.code === "EACCES") {
        console.log(err);
        process.exit(1);
      }
    });

    httpServer.listen(requestedPort, hostname);
    await once(httpServer, "listening");

    const addr = httpServer.address();
    if (addr && typeof addr === "object" && addr.port) {
      actualPort = addr.port;
    }
    showURL({ url: `https://${hostname}:${actualPort}`, AUTH_TOKEN });
    console.log(`TLS: key=${keyPath}\n     cert=${certPath}`);
  } else {
    httpServer = httpCreateServer(app);
    httpServer.on("error", (err: any) => {
      logger.error(
        "*".repeat(60) +
          `\nWARNING -- hub http server error: ${err.stack || err}\n` +
          "*".repeat(60),
      );
      if (err?.code === "EADDRINUSE" || err?.code === "EACCES") {
        console.log(err);
        process.exit(1);
      }
    });

    httpServer.listen(requestedPort, hostname);
    await once(httpServer, "listening");
    const addr = httpServer.address();
    if (addr && typeof addr === "object" && addr.port) {
      actualPort = addr.port;
    }
    showURL({ url: `http://${hostname}:${actualPort}`, AUTH_TOKEN });
  }

  const info: any = {};
  if (project_id != FALLBACK_PROJECT_UUID) {
    info.project_id = project_id;
  }
  if (account_id != FALLBACK_ACCOUNT_UUID) {
    info.account_id = account_id;
  }
  if (Object.keys(info).length > 0) {
    console.log(JSON.stringify(info, undefined, 2));
  }
  console.log("\n" + "*".repeat(60));
  initProjectProxy({ app, httpServer });
  return { httpServer, app, port: actualPort, isHttps, hostname };
}

export async function initApp({ app, conatClient, AUTH_TOKEN, isHttps }) {
  initAuth({ app, AUTH_TOKEN, isHttps });

  let pathToStaticAssets;
  if (fs.existsSync(join(STATIC_PATH, "app.html"))) {
    pathToStaticAssets = STATIC_PATH;
  } else {
    pathToStaticAssets = join(__dirname, "..", "static");
  }
  if (!fs.existsSync(join(pathToStaticAssets, "app.html"))) {
    throw Error("unable to find static assets");
  }

  // Ensure we are in a secure, cross-origin isolated context (COOP/COEP).
  // This will break Any cross-origin <script>, <img>, <iframe>, WASM, etc.
  // that is not served properly.
  app.use((_req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    next();
  });

  app.use("/static", express.static(pathToStaticAssets));

  app.use(
    "/webapp/favicon.ico",
    express.static(join(ASSET_PATH, "favicon.ico")),
  );
  app.use(
    "/webapp/serviceWorker.js",
    express.static(join(ASSET_PATH, "serviceWorker.js")),
  );

  app.get("/customize", async (_, res) => {
    const payload = await getCustomizePayload();
    payload.configuration.project_id = project_id;
    payload.configuration.account_id = account_id;
    res.json(payload);
  });

  // file download
  app.get(`/${project_id}/files/*`, async (req, res) => {
    await handleFileDownload({ req, res });
  });

  initBlobUpload(app, conatClient);
  initBlobDownload(app, conatClient);

  app.get("*", (req, res) => {
    if (req.url.endsWith("__webpack_hmr")) return;
    logger.debug("redirecting", req.url);
    const target = mapLiteTarget(req.originalUrl || req.url || "");
    if (!target) {
      res.redirect("/static/app.html");
      return;
    }
    const redirectUrl = new URL("http://host/static/app.html");
    redirectUrl.searchParams.set("target", target);
    res.redirect(redirectUrl.pathname + redirectUrl.search);
  });
}

function mapLiteTarget(rawUrl: string): string {
  const parsed = new URL(`http://host${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`);
  const pathname = parsed.pathname;
  let targetPath = "";
  if (pathname.startsWith("/projects/")) {
    targetPath = pathname.slice(1);
  } else if (pathname.startsWith(`/${project_id}/`)) {
    targetPath = `projects${pathname}`;
  } else if (
    pathname === "/files" ||
    pathname.startsWith("/files/") ||
    pathname === "/home" ||
    pathname.startsWith("/home/") ||
    pathname === "/new" ||
    pathname.startsWith("/new/") ||
    pathname === "/search" ||
    pathname.startsWith("/search/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/log" ||
    pathname.startsWith("/log/") ||
    pathname === "/port" ||
    pathname.startsWith("/port/") ||
    pathname === "/raw" ||
    pathname.startsWith("/raw/")
  ) {
    targetPath = `projects/${project_id}${pathname}`;
  } else {
    targetPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  }
  if (!targetPath || targetPath === "static/app.html") {
    return "";
  }
  return `${targetPath}${parsed.search || ""}`;
}

function initProjectProxy({
  app,
  httpServer,
}: {
  app: Application;
  httpServer: AnyServer;
}) {
  attachProxyServer({
    app,
    httpServer,
    base_url: project_id,
    host: "localhost",
  });
}

function sanitizeHost(rawHost: string): { isHttps: boolean; hostname: string } {
  // Accept: "localhost", "0.0.0.0", "https://localhost", etc.
  const trimmed = rawHost.trim();
  const isHttps = trimmed.startsWith("https://");
  if (isHttps) {
    const u = new URL(trimmed);
    return { isHttps: true, hostname: u.hostname };
  } else if (trimmed.startsWith("http://")) {
    const u = new URL(trimmed);
    return { isHttps: false, hostname: u.hostname };
  }
  return { isHttps: false, hostname: trimmed };
}

function showURL({ url, AUTH_TOKEN }) {
  const auth = AUTH_TOKEN
    ? `?auth_token=${encodeURIComponent(AUTH_TOKEN)}`
    : "";
  console.log("*".repeat(60) + "\n");
  console.log(`CoCalc Lite Server:  ${url}${auth}`);
  openUrlIfRequested(`${url}${auth}`);
}

function openUrlIfRequested(url: string) {
  const flag = (process.env.COCALC_OPEN_BROWSER || "").toLowerCase();
  if (flag !== "1" && flag !== "true" && flag !== "yes") return;
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // ignore failures (headless or missing opener)
  }
}
