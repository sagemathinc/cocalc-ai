/*
Expose the api/v2 handlers through a lightweight Express router so the hub can
run without Next.js in launchpad and other minimal deployments.
*/

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { existsSync, readdirSync, statSync } from "fs";
import { delimiter, join, sep } from "path";
import * as Module from "module";
import { getLogger } from "@cocalc/backend/logger";
import { applyBrowserCors } from "@cocalc/server/bay-public-origin";
import type { ApiV2ManifestEntry } from "./api-v2-manifest";

export interface ApiV2RouterOptions {
  includeDocs?: boolean;
  manifest?: ApiV2ManifestEntry[];
  rootDir?: string;
}

export default function createApiV2Router(
  opts: ApiV2RouterOptions = {},
): express.Router {
  const logger = getLogger("http-api-router");
  const router = express.Router();

  router.use(async (req, res, next) => {
    await applyBrowserCors(req, res);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  router.use(express.json({ limit: "10mb" }));
  router.use(express.urlencoded({ extended: true }));
  router.use(ensureCookies);

  const apiRoot = resolveApiRoot(opts.rootDir);
  ensureApiLibAlias(apiRoot, logger);
  const manifest =
    opts.manifest ?? (shouldUseManifest() ? loadManifest(logger) : []);
  const registered = new Set<string>();
  if (manifest.length > 0) {
    for (const entry of manifest) {
      if (!opts.includeDocs && entry.path === "/") {
        continue;
      }
      registered.add(entry.path);
      router.all(entry.path, wrapHandler(entry.handler, logger, entry.path));
    }
  }

  if (existsSync(apiRoot)) {
    const ext = pickExtension(apiRoot);
    const files = collectApiFiles(apiRoot, ext);
    for (const file of files) {
      const relative = toRelative(apiRoot, file);
      if (!opts.includeDocs && relative === `index${ext}`) {
        continue;
      }
      const routePath = toRoutePath(relative, ext);
      if (registered.has(routePath)) {
        continue;
      }
      const handler = loadHandler(file, logger);
      if (handler != null) {
        registered.add(routePath);
        router.all(routePath, wrapHandler(handler, logger, routePath));
      }
    }
  } else if (registered.size === 0) {
    throw new Error(`api v2 root not found: ${apiRoot}`);
  } else {
    logger.info("api v2 file root not found; using bundled manifest only", {
      apiRoot,
    });
  }

  return router;
}

function shouldUseManifest(): boolean {
  return !!process.env.COCALC_USE_API_V2_MANIFEST;
}

function resolveApiRoot(override?: string): string {
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

function ensureApiLibAlias(
  apiRoot: string,
  logger: ReturnType<typeof getLogger>,
) {
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

function loadManifest(
  logger: ReturnType<typeof getLogger>,
): ApiV2ManifestEntry[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("./api-v2-manifest") as {
      apiV2Manifest?: ApiV2ManifestEntry[];
    };
    return mod?.apiV2Manifest ?? [];
  } catch (err) {
    logger.warn("api v2 manifest load failed", { err });
    return [];
  }
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
  logger: ReturnType<typeof getLogger>,
): ((req: Request, res: Response) => any) | null {
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

function wrapHandler(
  handler: (req: Request, res: Response) => any,
  logger: ReturnType<typeof getLogger>,
  routePath: string,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: "api_v2_error" });
      }
      logger.warn("api v2 handler error", { routePath, err });
      next(err);
    }
  };
}

function ensureCookies(req: Request, _res: Response, next: NextFunction) {
  const reqAny = req as Request & { cookies?: Record<string, string> };
  if (!reqAny.cookies) {
    reqAny.cookies = {};
  }
  next();
}
