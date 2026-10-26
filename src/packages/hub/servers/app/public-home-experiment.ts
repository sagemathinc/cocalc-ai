/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The public Home page experiment (util/public-home-experiment.ts):
//   POST /home-experiment {variant, event}  adds one to an aggregate count
//   GET  /home-experiment/report?days=28    compares versions (admins only)
// No cookie is read or set, and nothing about the visitor is stored.

import express, { type Request, type Response, type Router } from "express";
import LRU from "lru-cache";
import { getLogger } from "@cocalc/backend/logger";
import getAccount from "@cocalc/server/auth/get-account";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import {
  getPublicHomeExperimentReport,
  recordPublicHomeExperimentEvent,
} from "@cocalc/server/public-home-experiment";
import { checkAndRecordCount } from "./connector-rate-limit";

const logger = getLogger("hub:servers:app:public-home-experiment");

// Per address. A school, office or campus behind one NAT address sends many
// visitors' events, so this is only a ceiling against floods, far above any
// real shared network.
const WINDOW_MS = 10 * 60_000;
export const PER_WINDOW = 5000;

export default function initPublicHomeExperiment(router: Router): void {
  const byAddress = new LRU<string, number>({ max: 100_000, ttl: WINDOW_MS });
  router.post(
    "/home-experiment",
    express.json({ limit: "1kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      // The page tags its sign-up links only after a 2xx answer, so only an
      // event that was stored gets one: an unknown or inactive version (the
      // running ones are public anyway) answers 422, a throttled address 429
      // and a failed write 503.
      const address = req.ip ?? req.socket.remoteAddress ?? "unknown";
      if (!checkAndRecordCount(byAddress, address, PER_WINDOW)) {
        res.status(429).end();
        return;
      }
      let stored: boolean;
      try {
        stored = await recordPublicHomeExperimentEvent({
          variant: req.body?.variant,
          event: req.body?.event,
        });
      } catch (err) {
        logger.warn("recording a home experiment event failed", {
          err: `${err}`.slice(0, 200),
        });
        res.status(503).end();
        return;
      }
      res.status(stored ? 204 : 422).end();
    },
  );

  router.get("/home-experiment/report", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "private, no-store");
    const account_id = await getAccount(req);
    if (!account_id || !(await userIsInGroup(account_id, "admin"))) {
      res.status(404).end();
      return;
    }
    try {
      const days = Number(req.query.days ?? 28);
      res.json(
        await getPublicHomeExperimentReport({
          days: Number.isFinite(days) ? days : 28,
        }),
      );
    } catch (err) {
      const message = `${(err as Error)?.message ?? err}`;
      if (/single-bay/.test(message)) {
        // A multi-bay site: no partial numbers, say why instead.
        res.status(409).json({ error: message });
        return;
      }
      logger.warn("home experiment report failed", { err: message });
      res.status(500).json({ error: "report failed" });
    }
  });
}
