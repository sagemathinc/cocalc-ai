/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response } from "express";
import { existsSync, readdirSync, statSync } from "fs";
import { delimiter, join, sep } from "path";
import * as Module from "module";
import { getLogger } from "@cocalc/backend/logger";

export type ApiV2Handler = (req: Request, res: Response) => any;

export type ApiV2RouteEntry = { path: string; handler: ApiV2Handler };

type ApiV2RouteLogger = Pick<ReturnType<typeof getLogger>, "info" | "warn">;

export interface DiscoverApiV2RoutesOptions {
  includeDocs?: boolean;
  logger?: ApiV2RouteLogger;
  rootDir?: string;
  ensureLibAlias?: boolean;
}

export function discoverApiV2Routes(
  opts: DiscoverApiV2RoutesOptions = {},
): ApiV2RouteEntry[] {
  const logger = opts.logger ?? getLogger("http-api-routes");
  const apiRoot = resolveApiV2Root(opts.rootDir);
  if (!existsSync(apiRoot)) {
    throw new Error(`api v2 root not found: ${apiRoot}`);
  }
  if (opts.ensureLibAlias !== false) {
    ensureApiV2LibAlias(apiRoot, logger);
  }
  const ext = pickExtension(apiRoot);
  const routes: ApiV2RouteEntry[] = [];
  for (const file of collectApiFiles(apiRoot, ext)) {
    const relative = toRelative(apiRoot, file);
    if (!opts.includeDocs && relative === `index${ext}`) {
      continue;
    }
    const handler = loadHandler(file, logger);
    if (handler == null) {
      continue;
    }
    routes.push({
      path: toRoutePath(relative, ext),
      handler,
    });
  }
  return routes;
}

export function resolveApiV2Root(override?: string): string {
  if (process.env.COCALC_API_V2_ROOT) {
    return process.env.COCALC_API_V2_ROOT;
  }
  if (override) {
    return override;
  }
  const bundleDir = process.env.COCALC_BUNDLE_DIR;
  if (bundleDir) {
    const bundledCandidates = [
      join(bundleDir, "http-api-dist", "pages", "api", "v2"),
      join(
        bundleDir,
        "bundle",
        "node_modules",
        "@cocalc",
        "http-api",
        "dist",
        "pages",
        "api",
        "v2",
      ),
    ];
    for (const bundled of bundledCandidates) {
      if (existsSync(bundled)) {
        return bundled;
      }
    }
  }
  return join(__dirname, "..", "pages", "api", "v2");
}

export function ensureApiV2LibAlias(
  apiRoot: string,
  logger: ApiV2RouteLogger,
): void {
  const distRoot = join(apiRoot, "..", "..", "..");
  const moduleImpl = Module as unknown as {
    _initPaths?: () => void;
    _cocalcApiV2LibPatched?: boolean;
  };
  if (moduleImpl._cocalcApiV2LibPatched) {
    return;
  }
  const current = (process.env.NODE_PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  if (!current.includes(distRoot)) {
    current.unshift(distRoot);
    process.env.NODE_PATH = current.join(delimiter);
  }
  if (typeof moduleImpl._initPaths === "function") {
    moduleImpl._initPaths();
  }
  moduleImpl._cocalcApiV2LibPatched = true;
  logger.info("api v2 configured NODE_PATH for lib/*", { distRoot });
}

function pickExtension(apiRoot: string): ".js" | ".ts" {
  if (existsSync(join(apiRoot, "index.js"))) {
    return ".js";
  }
  return ".ts";
}

function collectApiFiles(root: string, ext: ".js" | ".ts"): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir == null) {
      continue;
    }
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) {
        continue;
      }
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.endsWith(ext)) {
        continue;
      }
      if (entry.endsWith(`.test${ext}`) || entry.endsWith(`.spec${ext}`)) {
        continue;
      }
      out.push(full);
    }
  }
  return out.sort();
}

function toRelative(root: string, fullPath: string): string {
  return fullPath
    .slice(root.length + 1)
    .split(sep)
    .join("/");
}

function toRoutePath(relative: string, ext: ".js" | ".ts"): string {
  const route = relative.slice(0, -ext.length);
  if (route === "index") {
    return "/";
  }
  return `/${route}`;
}

function loadHandler(
  file: string,
  logger: ApiV2RouteLogger,
): ApiV2Handler | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    const handler = mod?.default ?? mod;
    if (typeof handler !== "function") {
      logger.warn("api v2 handler is not a function", { file });
      return null;
    }
    return handler;
  } catch (err) {
    logger.warn("api v2 handler load failed", { file, err });
    return null;
  }
}
