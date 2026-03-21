/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import express, { type Router } from "express";
import getAccount from "@cocalc/server/auth/get-account";
import { getLogger } from "@cocalc/hub/logger";
import {
  listVisibleRootfsImages,
  saveRootfsImage,
} from "@cocalc/server/rootfs/catalog";

const logger = getLogger("hub:servers:app:rootfs");

export default function init(router: Router) {
  const jsonParser = express.json({ limit: "256kb" });

  const sendManifest = async (req, res) => {
    try {
      const account_id = await getAccount(req);
      const manifest = await listVisibleRootfsImages(account_id);
      res.header("Content-Type", "application/json");
      res.send(JSON.stringify(manifest, null, 2));
    } catch (err) {
      logger.warn("rootfs catalog load failed", err);
      res.status(500).send("failed to load rootfs catalog");
    }
  };

  router.get("/rootfs/manifest.json", sendManifest);
  router.get("/rootfs/manifest.testing.json", sendManifest);
  router.get("/rootfs/catalog.json", sendManifest);

  router.post("/rootfs/catalog/save", jsonParser, async (req, res) => {
    try {
      const account_id = await getAccount(req);
      if (!account_id) {
        res.status(401).send("user must be signed in");
        return;
      }
      const entry = await saveRootfsImage({
        account_id,
        body: req.body ?? {},
      });
      res.json({ ok: true, entry });
    } catch (err) {
      const message = `${err}`;
      if (
        message.includes("must be specified") ||
        message.includes("not found")
      ) {
        res.status(400).send(message);
        return;
      }
      if (message.includes("not allowed")) {
        res.status(403).send(message);
        return;
      }
      logger.warn("rootfs catalog save failed", err);
      res.status(500).send("failed to save rootfs catalog entry");
    }
  });
}
