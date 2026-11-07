/*
Expose the api/v2 handlers through a lightweight Express router so the hub can
run without Next.js in launchpad and other minimal deployments.
*/

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { getLogger } from "@cocalc/backend/logger";
import { applyBrowserCors } from "@cocalc/server/bay-public-origin";
import {
  discoverApiV2Routes,
  loadEmbeddedApiV2Routes,
  validateApiV2Routes,
  type ApiV2RouteEntry,
} from "./api-v2-routes";
import { getLaunchpadApiV2Routes } from "./launchpad-routes";

export interface ApiV2RouterOptions {
  browserCors?: "configured" | "request-origin";
  includeDocs?: boolean;
  routes?: ApiV2RouteEntry[];
  // Deprecated compatibility alias.
  manifest?: ApiV2RouteEntry[];
  rootDir?: string;
}

function loadBundledRoutes(
  logger: ReturnType<typeof getLogger>,
): ApiV2RouteEntry[] | undefined {
  const embeddedRoutes = loadEmbeddedApiV2Routes();
  if (embeddedRoutes != null) {
    logger.info("using embedded api v2 routes", {
      count: embeddedRoutes.length,
    });
    return embeddedRoutes;
  }

  const bundle = process.env.COCALC_API_V2_ROUTES_BUNDLE;
  if (!bundle) {
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(bundle);
    const routes = validateApiV2Routes(
      mod?.routes ?? mod?.default,
      "api v2 route bundle",
    );
    logger.info("using bundled api v2 routes", {
      bundle,
      count: routes.length,
    });
    return routes;
  } catch (err) {
    logger.warn("api v2 bundled routes load failed", { bundle, err });
    throw err;
  }
}

function loadLaunchpadRoutes(
  logger: ReturnType<typeof getLogger>,
): ApiV2RouteEntry[] | undefined {
  if (process.env.COCALC_LAUNCHPAD_API_V2_ROUTES !== "1") {
    return;
  }
  const routes = getLaunchpadApiV2Routes();
  logger.info("using launchpad api v2 routes", { count: routes.length });
  return routes;
}

export default function createApiV2Router(
  opts: ApiV2RouterOptions = {},
): express.Router {
  const logger = getLogger("http-api-router");
  const router = express.Router();

  router.use(async (req, res, next) => {
    await applyBrowserCors(req, res, {
      requestOriginOnly: opts.browserCors === "request-origin",
    });
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  router.use(unlessRawBodyRoute(express.json({ limit: "10mb" })));
  router.use(unlessRawBodyRoute(express.urlencoded({ extended: true })));
  router.use(ensureCookies);

  const routes =
    opts.routes ??
    opts.manifest ??
    loadBundledRoutes(logger) ??
    loadLaunchpadRoutes(logger) ??
    discoverApiV2Routes({
      includeDocs: opts.includeDocs,
      logger,
      rootDir: opts.rootDir,
    });
  for (const entry of routes) {
    router.all(entry.path, wrapHandler(entry.handler, logger, entry.path));
  }

  return router;
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

// Routes that bound and strictly parse their own request bodies, so the shared
// parsers must not read them first. Matched like Express matches routes:
// case-insensitively, with or without a trailing slash.
export const RAW_BODY_ROUTES = new Set(["/support/sagebrush-intake"]);

export function isRawBodyRoute(path: string): boolean {
  return RAW_BODY_ROUTES.has(`${path ?? ""}`.toLowerCase().replace(/\/+$/, ""));
}

function unlessRawBodyRoute(
  parser: (req: Request, res: Response, next: NextFunction) => void,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isRawBodyRoute(req.path)) {
      next();
      return;
    }
    parser(req, res, next);
  };
}

function ensureCookies(req: Request, _res: Response, next: NextFunction) {
  const reqAny = req as Request & { cookies?: Record<string, string> };
  if (!reqAny.cookies) {
    reqAny.cookies = {};
  }
  next();
}
