/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { PassThrough } from "node:stream";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import formidable from "formidable";
import getLogger from "@cocalc/backend/logger";
import { writeFile as writeFileToProject } from "@cocalc/conat/files/write";
import type { Client as ConatClient } from "@cocalc/conat/core/client";

const logger = getLogger("project-host:upload");

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

const errors: { [key: string]: string[] } = {};
const finished: { [key: string]: { state: boolean; cb: () => void } } = {};
const stateMeta: { [key: string]: { created: number; touched: number } } = {};
const streams: Record<string, PassThrough | undefined> = {};

function waitForReady(register: (cb: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => register(resolve));
}

export async function handleProjectHostUpload({
  client,
  project_id,
  path,
  req,
  res,
  writeServiceName,
  ensureWriteServer,
}: {
  client: ConatClient;
  project_id: string;
  path: unknown;
  req: IncomingMessage;
  res: ServerResponse;
  writeServiceName: string;
  ensureWriteServer: () => Promise<void>;
}): Promise<void> {
  if (typeof path != "string") {
    throw Error("path must be given");
  }
  await ensureWriteServer();

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
    res.statusCode = 500;
    res.end("Upload failed.");
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
          client,
          project_id,
          name: writeServiceName,
          stream,
          path: join(path, fields.fullPath?.[0] ?? filename),
          maxWait: MAX_UPLOAD_TIME_MS,
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
  let finalErrors: string[] | undefined;
  if (index == count - 1) {
    if (!done.state) {
      await waitForReady((cb) => {
        done.cb = cb;
      });
    }
    const totalStream = stream as PassThrough | null;
    totalStream?.end();
    if (!finished[key].state) {
      await waitForReady((cb) => {
        finished[key].cb = cb;
      });
    }
    finalErrors = [...(errors[key] ?? [])];
    cleanupUploadKey(key);
  }
  const uploadErrors = finalErrors ?? errors[key] ?? [];
  if (uploadErrors.length > 0) {
    logger.warn("upload failed (backend write)", {
      key,
      errors: uploadErrors,
    });
    res.statusCode = 500;
    res.end("Upload failed.");
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
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
}

function pruneUploadState(): void {
  const now = Date.now();
  for (const [key, meta] of Object.entries(stateMeta)) {
    if (now - meta.touched > UPLOAD_STATE_TTL_MS) {
      logger.warn("pruning stale upload state", { key, meta });
      cleanupUploadKey(key);
      delete streams[key];
    }
  }
  const keys = Object.keys(stateMeta);
  if (keys.length <= MAX_UPLOAD_STATE_ENTRIES) {
    return;
  }
  keys
    .sort((a, b) => stateMeta[a].touched - stateMeta[b].touched)
    .slice(0, keys.length - MAX_UPLOAD_STATE_ENTRIES)
    .forEach((key) => {
      logger.warn("pruning excess upload state", { key });
      cleanupUploadKey(key);
      delete streams[key];
    });
}
