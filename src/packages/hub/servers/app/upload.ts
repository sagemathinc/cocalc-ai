/*
Support user uploading files directly to CoCalc from their browsers.

- uploading to projects, with full support for potentially very LARGE file
  uploads that stream via Conat. This checks users is authenticated with write
  access.

- uploading blobs to our database.

Which of the above happens depends on query params.

NOTE: Code for downloading files from projects is in the middle of
packages/hub/proxy/handle-request.ts

I'm sorry the code below is so insane.  It was extremely hard to write
and involves tricky state in subtle ways all over the place, due to
how the uploads are chunked and sent in bits by Dropzone, which is absolutely
necessary due to how cloudflare works.
*/

import { Router } from "express";
import { getLogger } from "@cocalc/hub/logger";
import getAccount from "@cocalc/server/auth/get-account";
import isCollaborator from "@cocalc/server/projects/is-collaborator";
import formidable from "formidable";
import { PassThrough } from "node:stream";
import { writeFile as writeFileToProject } from "@cocalc/conat/files/write";
import { join } from "path";
import { callback } from "awaiting";

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Upper bound for waiting on the backend writer for a single upload.
const MAX_UPLOAD_TIME_MS = envNumber(
  "COCALC_UPLOAD_MAX_WAIT_MS",
  1000 * 60 * 60 * 6, // 6 hours
);
// TTL for in-memory upload state. This bounds leaks if the client disconnects
// mid-upload and never sends final chunks.
const UPLOAD_STATE_TTL_MS = envNumber(
  "COCALC_UPLOAD_STATE_TTL_MS",
  Math.max(MAX_UPLOAD_TIME_MS * 2, 1000 * 60 * 30), // at least 30 minutes
);
// Hard cap to prevent unbounded growth of upload state maps.
const MAX_UPLOAD_STATE_ENTRIES = envNumber(
  "COCALC_UPLOAD_MAX_STATE_ENTRIES",
  2000,
);

const logger = getLogger("hub:servers:app:upload");

export default function init(router: Router) {
  router.post("/upload", async (req, res) => {
    const account_id = await getAccount(req);
    if (!account_id) {
      res.status(500).send("user must be signed in to upload files");
      return;
    }
    const { project_id, path = "", blob } = req.query;
    try {
      if (blob) {
        //await handleBlobUpload({ ttl, req, res });
        throw Error("not implemented");
      } else {
        await handleUploadToProject({
          account_id,
          project_id,
          path,
          req,
          res,
        });
      }
    } catch (err) {
      logger.warn("upload failed", {
        err: String(err),
        account_id,
        project_id,
      });
      res.status(500).send("upload failed");
    }
  });
}

// async function handleBlobUpload({ ttl, req, res }) {
//   throw Error("blob handling not implemented");
// }

const errors: { [key: string]: string[] } = {};
const finished: { [key: string]: { state: boolean; cb: () => void } } = {};
const stateMeta: { [key: string]: { created: number; touched: number } } = {};

async function handleUploadToProject({
  account_id,
  project_id,
  path,
  req,
  res,
}) {
  logger.debug({
    account_id,
    project_id,
    path,
  });

  if (
    typeof project_id != "string" ||
    !(await isCollaborator({ account_id, project_id }))
  ) {
    throw Error("user must be collaborator on project");
  }
  if (typeof path != "string") {
    throw Error("path must be given");
  }
  const done = { state: false, cb: () => {} };
  let filename = "noname.txt";
  let stream: any | null = null;
  let chunkStream: any | null = null;
  const form = formidable({
    keepExtensions: true,
    hashAlgorithm: "sha1",
    // file = {"size":195,"newFilename":"649205cf239d49f350c645f00.py","originalFilename":"a (2).py","mimetype":"application/octet-stream","hash":"318c0246ae31424f9225b566e7e09bef6c8acc40"}
    fileWriteStreamHandler: (file) => {
      filename = file?.["originalFilename"] ?? "noname.txt";
      const { chunkStream: chunkStream0, totalStream } = getWriteStream({
        project_id,
        path,
        filename,
      });
      chunkStream = chunkStream0;
      stream = totalStream;
      (async () => {
        for await (const data of chunkStream) {
          stream.write(data);
        }
        done.state = true;
        done.cb();
      })();
      return chunkStream;
    },
  });

  const [fields] = await form.parse(req);
  // console.log("form", { fields, files });
  // fields looks like this: {"dzuuid":["ce5fa828-5155-4fa0-b30a-869bd4c956a5"],"dzchunkindex":["1"],"dztotalfilesize":["10000000"],"dzchunksize":["8000000"],"dztotalchunkcount":["2"],"dzchunkbyteoffset":["8000000"]}

  // console.log({ filename, fields, path, files });

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
    // start brand new upload. this is the only time we clear the errors map.
    errors[key] = [];
    finished[key] = { state: false, cb: () => {} };
    // @ts-ignore
    (async () => {
      try {
        // console.log("conat: started writing ", filename);
        await writeFileToProject({
          stream,
          project_id,
          path: join(path, fields.fullPath?.[0] ?? filename),
          maxWait: MAX_UPLOAD_TIME_MS,
        });
        // console.log("conat: finished writing ", filename);
      } catch (err) {
        // console.log("conat: error ", err);
        errors[key].push(`${err}`);
      } finally {
        // console.log("conat: freeing write stream");
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
    // console.log("finish");
    if (!done.state) {
      const f = (cb) => {
        done.cb = cb;
      };
      await callback(f);
    }
    stream.end();
    if (!finished[key].state) {
      const f = (cb) => {
        finished[key].cb = cb;
      };
      await callback(f);
    }
    cleanupUploadKey(key);
  }
  if ((errors[key]?.length ?? 0) > 0) {
    logger.warn("upload failed (backend write)", {
      key,
      errors: errors[key],
    });
    const serviceUnavailable = errors[key].some((e) => e.includes("Error: 503"));
    res
      .status(500)
      .send(
        serviceUnavailable
          ? "Upload failed: upload service not running."
          : "Upload failed.",
      );
  } else {
    // console.log("saying upload worked");
    res.send({ status: "ok" });
  }
}

function getKey(opts) {
  return JSON.stringify(opts);
}

const streams: any = {};
export function getWriteStream(opts) {
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
