import { Router } from "express";
import { getLogger } from "@cocalc/backend/logger";
import { writeFile as writeFileToProject } from "@cocalc/conat/files/write";
import { conat } from "@cocalc/backend/conat";
import formidable from "formidable";
import { join } from "path";
import { PassThrough } from "node:stream";
import { project_id as liteProjectId } from "@cocalc/project/data";

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_UPLOAD_TIME_MS = envNumber(
  "COCALC_UPLOAD_MAX_WAIT_MS",
  1000 * 60 * 60 * 6,
);
const UPLOAD_STATE_TTL_MS = envNumber(
  "COCALC_UPLOAD_STATE_TTL_MS",
  Math.max(MAX_UPLOAD_TIME_MS * 2, 1000 * 60 * 30),
);
const MAX_UPLOAD_STATE_ENTRIES = envNumber(
  "COCALC_UPLOAD_MAX_STATE_ENTRIES",
  2000,
);

const logger = getLogger("lite:hub:upload");

const errors: { [key: string]: string[] } = {};
const finished: { [key: string]: { state: boolean; cb: () => void } } = {};
const stateMeta: { [key: string]: { created: number; touched: number } } = {};
const streams: Record<string, PassThrough | undefined> = {};

function waitForReady(register: (cb: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => register(resolve));
}

export default function init(router: Router) {
  router.post("/upload", async (req, res) => {
    const requestedProjectId = `${req.query.project_id ?? liteProjectId}`;
    const path = req.query.path;
    try {
      if (requestedProjectId !== liteProjectId) {
        throw Error(`unknown project_id '${requestedProjectId}'`);
      }
      await handleUploadToProject({
        project_id: liteProjectId,
        path,
        req,
        res,
      });
    } catch (err) {
      logger.warn("upload failed", {
        err: String(err),
        project_id: requestedProjectId,
        path,
      });
      res.status(500).send("upload failed");
    }
  });
}

async function handleUploadToProject({
  project_id,
  path,
  req,
  res,
}: {
  project_id: string;
  path: unknown;
  req;
  res;
}) {
  logger.debug({
    project_id,
    path,
  });

  if (typeof path != "string") {
    throw Error("path must be given");
  }
  const done = { state: false, cb: () => {} };
  let filename = "noname.txt";
  let stream: PassThrough | null = null;
  let chunkStream: PassThrough | null = null;
  const form = formidable({
    keepExtensions: true,
    hashAlgorithm: "sha1",
    fileWriteStreamHandler: (file) => {
      filename = file?.["originalFilename"] ?? "noname.txt";
      const { chunkStream: nextChunkStream, totalStream } = getWriteStream({
        project_id,
        path,
        filename,
      });
      chunkStream = nextChunkStream;
      stream = totalStream;
      void (async () => {
        for await (const data of chunkStream!) {
          stream!.write(data);
        }
        done.state = true;
        done.cb();
      })();
      return chunkStream;
    },
  });

  const [fields] = await form.parse(req);

  const index = parseInt(fields.dzchunkindex?.[0] ?? "0");
  const count = parseInt(fields.dztotalchunkcount?.[0] ?? "1");
  const key = JSON.stringify({ path, filename, project_id });
  touchStateKey(key);
  pruneUploadState();
  if (index > 0 && errors?.[key]?.length > 0) {
    logger.warn("upload failed (early state error)", {
      key,
      errors: errors[key],
    });
    res.status(500).send("Upload failed.");
    cleanupUploadKey(key);
    return;
  }
  if (index == 0) {
    errors[key] = [];
    finished[key] = { state: false, cb: () => {} };
    void (async () => {
      try {
        if (stream == null) {
          throw new Error("upload stream not initialized");
        }
        await writeFileToProject({
          stream,
          project_id,
          path: join(path, fields.fullPath?.[0] ?? filename),
          maxWait: MAX_UPLOAD_TIME_MS,
          client: conat(),
        });
      } catch (err) {
        errors[key].push(`${err}`);
      } finally {
        freeWriteStream({
          project_id,
          path,
          filename,
        });
        finished[key].state = true;
        finished[key].cb();
      }
    })();
  }
  if (index == count - 1) {
    if (!done.state) {
      await waitForReady((cb) => {
        done.cb = cb;
      });
    }
    const totalStream = stream as PassThrough | null;
    if (totalStream != null) {
      totalStream.end();
    }
    if (!finished[key].state) {
      await waitForReady((cb) => {
        finished[key].cb = cb;
      });
    }
    cleanupUploadKey(key);
  }
  if ((errors[key]?.length ?? 0) > 0) {
    logger.warn("upload failed (backend write)", {
      key,
      errors: errors[key],
    });
    const serviceUnavailable = errors[key].some((e) =>
      e.includes("Error: 503"),
    );
    res
      .status(500)
      .send(
        serviceUnavailable
          ? "Upload failed: upload service not running."
          : "Upload failed.",
      );
  } else {
    res.send({ status: "ok" });
  }
}

function getKey(opts) {
  return JSON.stringify(opts);
}

function getWriteStream(opts) {
  pruneUploadState();
  const key = getKey(opts);
  touchStateKey(key);
  let totalStream = streams[key];
  if (totalStream == null) {
    totalStream = new PassThrough();
    streams[key] = totalStream;
  }
  const chunkStream = new PassThrough();
  return { chunkStream, totalStream };
}

function freeWriteStream(opts) {
  const key = getKey(opts);
  const stream = streams[key];
  if (stream != null) {
    try {
      stream.end();
    } catch {}
    delete streams[key];
  }
}

function touchStateKey(key: string): void {
  const now = Date.now();
  const meta = stateMeta[key];
  if (meta == null) {
    stateMeta[key] = { created: now, touched: now };
  } else {
    meta.touched = now;
  }
}

function cleanupUploadKey(key: string): void {
  delete errors[key];
  delete finished[key];
  delete stateMeta[key];
  const stream = streams[key];
  if (stream != null) {
    try {
      stream.end();
    } catch {}
    delete streams[key];
  }
}

function pruneUploadState(): void {
  const now = Date.now();
  const keys = Object.keys(stateMeta);
  for (const key of keys) {
    if (now - stateMeta[key].touched > UPLOAD_STATE_TTL_MS) {
      cleanupUploadKey(key);
    }
  }
  const remaining = Object.keys(stateMeta);
  if (remaining.length <= MAX_UPLOAD_STATE_ENTRIES) {
    return;
  }
  remaining
    .sort((a, b) => stateMeta[a].touched - stateMeta[b].touched)
    .slice(0, remaining.length - MAX_UPLOAD_STATE_ENTRIES)
    .forEach(cleanupUploadKey);
}
