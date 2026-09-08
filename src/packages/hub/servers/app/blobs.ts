import { Router } from "express";
import { basename, extname } from "node:path";
import { is_valid_uuid_string } from "@cocalc/util/misc";
import { database_is_working } from "@cocalc/server/metrics/hub_register";
import { getLogger } from "@cocalc/hub/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOriginForRequest } from "@cocalc/server/bay-public-origin";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { resolveBlobStorageConfig } from "@cocalc/server/blobs/config";
import { isPublicBlobAvailable } from "@cocalc/server/blobs/public-url";
import { detectRasterImage } from "@cocalc/server/blobs/media";
import { readBlobFromDatabase } from "@cocalc/server/blobs/read";

const logger = getLogger("hub:servers:app:blobs");

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

function canRedirectToPublicBlobUrl({
  explicitDownload,
  filename,
}: {
  explicitDownload: boolean;
  filename: string;
}): boolean {
  if (explicitDownload) return false;

  // Old pasted-image URLs often use extensionless display names such as
  // /blobs/paste-...?...uuid=...; keep those on the R2/Cloudflare path.
  const ext = extname(filename).toLowerCase();
  return !ext || shouldInlineByFilename(filename);
}

export default function init(router: Router) {
  // return uuid-indexed blobs (mainly used for graphics)
  router.get("/blobs/*path", async (req, res) => {
    const seedBayId = getConfiguredClusterSeedBayId();
    if (getConfiguredBayId() !== seedBayId) {
      const seedOrigin = await getBayPublicOriginForRequest(req, seedBayId);
      if (seedOrigin) {
        res.redirect(
          302,
          `${seedOrigin.replace(/\/+$/, "")}${req.originalUrl}`,
        );
        return;
      }
    }
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
    const filename = safeFilenameFromPath(req.path);
    const explicitDownload = req.query.download != null;
    let storageConfig: Awaited<ReturnType<typeof resolveBlobStorageConfig>>;
    try {
      storageConfig = await resolveBlobStorageConfig();
    } catch (err) {
      logger.error(`invalid blob storage configuration -- ${err}`);
      res.status(500).send("invalid blob storage configuration");
      return;
    }
    const publicUrl =
      canRedirectToPublicBlobUrl({ explicitDownload, filename }) &&
      storageConfig.activeBackend === "r2" &&
      storageConfig.r2?.publicBaseUrl
        ? `${storageConfig.r2.publicBaseUrl}/${uuid}`
        : undefined;
    if (publicUrl && (await isPublicBlobAvailable(publicUrl))) {
      res.redirect(302, publicUrl);
      return;
    }
    if (!database_is_working() && storageConfig.activeBackend !== "r2") {
      res.status(404).send("can't get blob -- not connected to database");
      return;
    }

    try {
      const data = await readBlobFromDatabase(uuid);
      if (data == null) {
        res.status(404).send("blob not found");
      } else {
        const media = detectRasterImage(data);
        const forceDownload = explicitDownload || media == null;
        if (forceDownload) {
          // Force download for anything that is not an explicitly safe inline
          // type, to avoid serving executable content (e.g. HTML/SVG/JS) on
          // hub origin.
          res.attachment(filename);
        } else {
          res.type(media.contentType);
        }
        res.set("X-Content-Type-Options", "nosniff");
        // Cache as long as possible (e.g., One year in seconds), since
        // what we are returning is defined by a sha1 hash, so cannot change.
        res.set(
          "Cache-Control",
          `public, max-age=${365 * 24 * 60 * 60}, immutable`,
        );
        // "public means that the response may be cached by clients and any
        // intermediary caches (like CDNs). max-age determines the amount
        // of time (in seconds) a client should cache the response."
        // The maximum value that you can set for max-age is 1 year
        // (in seconds), which is compliant with the HTTP/1.1
        // specifications (RFC2616)."
        res.set("ETag", uuid);
        res.send(data);
      }
    } catch (err) {
      logger.error(`internal error ${err} getting blob ${uuid}`);
      res.status(500).send("internal error getting blob");
    }
  });
}
