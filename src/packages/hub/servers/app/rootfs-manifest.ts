/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { type Router } from "express";
import getAccount from "@cocalc/server/auth/get-account";
import { getLogger } from "@cocalc/hub/logger";
import { listVisibleRootfsImages } from "@cocalc/server/rootfs/catalog";
import {
  appendUploadedRootfsReleaseArtifactChunk,
  rootfsReleaseArtifactContentType,
  rootfsReleaseArtifactLocalPath,
  storeUploadedRootfsReleaseArtifact,
  streamStoredRootfsReleaseArtifact,
  verifyRootfsArtifactToken,
} from "@cocalc/server/rootfs/releases";
import { stat } from "node:fs/promises";

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

  router.put("/rootfs/releases/:content_key/artifact", async (req, res) => {
    const content_key = `${req.params?.content_key ?? ""}`.trim();
    try {
      await verifyRootfsArtifactToken({
        token: `${req.query?.token ?? ""}`,
        kind: "upload",
        content_key,
      });
      const upload_id = `${req.query?.upload_id ?? ""}`.trim();
      const partRaw = `${req.query?.part ?? ""}`.trim();
      const partsRaw = `${req.query?.parts ?? ""}`.trim();
      if (upload_id || partRaw || partsRaw) {
        const part = Number.parseInt(partRaw, 10);
        const parts = Number.parseInt(partsRaw, 10);
        const chunk = await appendUploadedRootfsReleaseArtifactChunk({
          content_key,
          upload_id,
          part,
          parts,
          input: req,
        });
        res.status(chunk.complete ? 201 : 202).json({
          ok: true,
          complete: chunk.complete,
          ...(chunk.metadata ? { metadata: chunk.metadata } : {}),
        });
        return;
      }
      const metadata = await storeUploadedRootfsReleaseArtifact({
        content_key,
        input: req,
      });
      res.status(201).json(metadata);
    } catch (err) {
      logger.warn("rootfs artifact upload failed", {
        content_key,
        err: `${err}`,
      });
      res.status(400).send(`${err}`);
    }
  });

  router.get("/rootfs/releases/:content_key/artifact", async (req, res) => {
    const content_key = `${req.params?.content_key ?? ""}`.trim();
    try {
      await verifyRootfsArtifactToken({
        token: `${req.query?.token ?? ""}`,
        kind: "download",
        content_key,
      });
      const path = rootfsReleaseArtifactLocalPath(content_key);
      const info = await stat(path);
      res.status(200);
      res.setHeader("Content-Type", rootfsReleaseArtifactContentType());
      res.setHeader("Content-Length", `${info.size}`);
      res.setHeader("Cache-Control", "private, max-age=60");
      await streamStoredRootfsReleaseArtifact(content_key, res);
    } catch (err) {
      logger.warn("rootfs artifact download failed", {
        content_key,
        err: `${err}`,
      });
      if (!res.headersSent) {
        res.status(404).send(`${err}`);
      } else {
        res.end();
      }
    }
  });
}
