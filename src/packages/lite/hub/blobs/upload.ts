import { MAX_BLOB_SIZE } from "@cocalc/util/db-schema/blobs";
import formidable from "formidable";
import { readFile, unlink } from "fs/promises";
import { performance } from "node:perf_hooks";
import { uuidsha1 } from "@cocalc/backend/misc_node";
import getLogger from "@cocalc/backend/logger";
import { getBlobstore } from "./download";

export const BLOB_STORE_NAME = "blobs";

const logger = getLogger("lite:hub:blobs:upload");
const BLOB_UPLOAD_SLOW_MS = envNumber("COCALC_BLOB_UPLOAD_SLOW_MS", 250);

function envNumber(name: string, fallback: number): number {
  const value = `${process.env[name] ?? ""}`.trim();
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export default function init(app, conatClient) {
  const blobStore = getBlobstore(conatClient);
  logger.debug("initialized blob upload service");
  app.post("/blobs", async (req, res) => {
    const { ttl } = req.query;
    const started = performance.now();
    let parseMs = 0;
    let readMs = 0;
    let storeMs = 0;
    let bytes = 0;
    let uuid: string | undefined = undefined;
    try {
      const form = formidable({
        keepExtensions: true,
        maxFileSize: MAX_BLOB_SIZE,
        hashAlgorithm: "sha1",
      });

      const parseStarted = performance.now();
      const [_, files] = await form.parse(req);
      parseMs = performance.now() - parseStarted;
      if (files.file?.[0] != null) {
        const { filepath, hash } = files.file[0];
        try {
          if (typeof hash == "string") {
            uuid = uuidsha1("", hash);
          }
          logger.debug("got blob ", uuid);
          if (!uuid) {
            throw Error(`blob upload -- file hash missing ${filepath}`);
          }
          const readStarted = performance.now();
          const blob = await readFile(filepath);
          readMs = performance.now() - readStarted;
          bytes = blob.byteLength;
          const storeStarted = performance.now();
          await blobStore.set(uuid, blob, { ttl });
          storeMs = performance.now() - storeStarted;
        } finally {
          try {
            await unlink(filepath);
          } catch (err) {
            logger.debug("WARNING -- failed to delete uploaded file", err);
          }
        }
      }
      if (!uuid) {
        res.status(500).send("no file got uploaded");
        return;
      }
      const durationMs = performance.now() - started;
      logger.debug("blob upload complete", {
        uuid,
        ttl,
        bytes,
        durationMs: roundMs(durationMs),
        parseMs: roundMs(parseMs),
        readMs: roundMs(readMs),
        storeMs: roundMs(storeMs),
      });
      if (durationMs >= BLOB_UPLOAD_SLOW_MS) {
        logger.warn("blob upload slow", {
          uuid,
          ttl,
          bytes,
          durationMs: roundMs(durationMs),
          parseMs: roundMs(parseMs),
          readMs: roundMs(readMs),
          storeMs: roundMs(storeMs),
        });
      }
      res.send({ uuid });
    } catch (err) {
      logger.warn("blob upload failed", {
        err: String(err),
        uuid,
        ttl,
        bytes,
        durationMs: roundMs(performance.now() - started),
        parseMs: roundMs(parseMs),
        readMs: roundMs(readMs),
        storeMs: roundMs(storeMs),
      });
      res.status(500).send("upload failed");
    }
  });
}
