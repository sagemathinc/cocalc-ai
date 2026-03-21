/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type Router } from "express";
import getAccount from "@cocalc/server/auth/get-account";
import { getLogger } from "@cocalc/hub/logger";
import { listVisibleRootfsImages } from "@cocalc/server/rootfs/catalog";

const logger = getLogger("hub:servers:app:rootfs");

export default function init(router: Router) {
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
}
