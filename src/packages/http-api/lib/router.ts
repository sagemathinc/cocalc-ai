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
import { discoverApiV2Routes, type ApiV2RouteEntry } from "./api-v2-routes";

export interface ApiV2RouterOptions {
  includeDocs?: boolean;
  routes?: ApiV2RouteEntry[];
  // Deprecated compatibility alias.
  manifest?: ApiV2RouteEntry[];
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

  const routes =
    opts.routes ??
    opts.manifest ??
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

function ensureCookies(req: Request, _res: Response, next: NextFunction) {
  const reqAny = req as Request & { cookies?: Record<string, string> };
  if (!reqAny.cookies) {
    reqAny.cookies = {};
  }
  next();
}
