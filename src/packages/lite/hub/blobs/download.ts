/*
Download blob from blob-store
*/

import { BLOB_STORE_NAME } from "./upload";
import getLogger from "@cocalc/backend/logger";
import { type AKV } from "@cocalc/conat/sync/akv";
import { basename, extname } from "node:path";
import { is_valid_uuid_string } from "@cocalc/util/misc";

const logger = getLogger("lite:hub:blobs:download");

const SAFE_INLINE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
]);

function safeFilenameFromPath(pathname: string): string {
  const name = basename(pathname || "") || "blob";
  return name.replace(/[^\w.\-()+ ]+/g, "_");
}

function shouldInlineByFilename(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return SAFE_INLINE_IMAGE_EXTENSIONS.has(ext);
}

export function getBlobstore(conatClient): AKV {
  return conatClient.sync.akv({ name: BLOB_STORE_NAME });
}

export default function init(app, conatClient) {
  const blobStore = getBlobstore(conatClient);
  logger.debug("initialized blob download service");

  app.get("/blobs/*", async (req, res) => {
    logger.debug(`${JSON.stringify(req.query)}, ${req.path}`);
    const uuid = `${req.query.uuid}`;
    if (req.headers["if-none-match"] === uuid) {
      res.sendStatus(304);
      return;
    }
    if (!is_valid_uuid_string(uuid)) {
      res.status(404).send("invalid blob id");
      return;
    }
    try {
      const data = await blobStore.get(uuid);
      if (data == null) {
        res.status(404).send("blob not found");
      } else {
        const filename = safeFilenameFromPath(req.path);
        const forceDownload =
          req.query.download != null || !shouldInlineByFilename(filename);
        if (forceDownload) {
          // tell browser to download the link as a file instead
          // of displaying it in browser
          res.attachment(filename);
        } else {
          res.type(filename);
        }
        res.set("X-Content-Type-Options", "nosniff");
        // see comments in src/packages/hub/servers/app/blobs.ts
        res.set("Cache-Control", `public, max-age=${365 * 24 * 60 * 60}`);
        res.set("ETag", uuid);
        res.send(data);
      }
    } catch (err) {
      logger.error(`WARNING: error getting blob ${uuid}`, err);
      res.status(500).send("internal error getting blob");
    }
  });
}
