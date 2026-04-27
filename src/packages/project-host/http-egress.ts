/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { IncomingMessage, ServerResponse } from "http";
import getLogger from "@cocalc/backend/logger";
import type { AppProxyExposureMode } from "@cocalc/backend/auth/app-proxy";

const logger = getLogger("project-host:http-egress");

const HTTP_EGRESS_TRACKER = Symbol("project-host-http-egress-tracker");

export const MANAGED_HTTP_EGRESS_CATEGORY = "http-proxy";

type RecordManagedHttpEgressFn = (opts: {
  bytes: number;
  request_path: string;
  method: string;
  status_code: number;
  exposure_mode: AppProxyExposureMode;
  partial: boolean;
}) => Promise<void> | void;

function getRequestPath(req: IncomingMessage): string {
  try {
    const parsed = new URL(req.url ?? "/", "http://project-host.local");
    return parsed.pathname || "/";
  } catch {
    return (req.url ?? "/").split("?")[0] || "/";
  }
}

function getChunkByteLength(
  chunk: unknown,
  encoding?: BufferEncoding | string,
): number {
  if (chunk == null) return 0;
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk, encoding as BufferEncoding | undefined);
  }
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return 0;
}

export function attachManagedHttpEgressRecorder({
  req,
  res,
  exposure_mode,
  record,
}: {
  req: IncomingMessage;
  res: ServerResponse;
  exposure_mode: AppProxyExposureMode;
  record: RecordManagedHttpEgressFn;
}): void {
  if ((res as any)[HTTP_EGRESS_TRACKER]) {
    return;
  }
  (res as any)[HTTP_EGRESS_TRACKER] = true;

  const request_path = getRequestPath(req);
  const method = `${req.method ?? "GET"}`.toUpperCase();
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let bytes = 0;
  let finalized = false;

  const finalize = (partial: boolean) => {
    if (finalized) return;
    finalized = true;
    if (!(bytes > 0)) return;
    void Promise.resolve(
      record({
        bytes,
        request_path,
        method,
        status_code: res.statusCode,
        exposure_mode,
        partial,
      }),
    ).catch((err) => {
      logger.warn("unable to record managed http egress", {
        request_path,
        method,
        status_code: res.statusCode,
        exposure_mode,
        partial,
        bytes,
        err: `${err}`,
      });
    });
  };

  res.write = ((chunk: any, ...args: any[]) => {
    const encoding =
      typeof args[0] === "string" ? (args[0] as BufferEncoding) : undefined;
    bytes += getChunkByteLength(chunk, encoding);
    return originalWrite(chunk, ...args);
  }) as typeof res.write;

  res.end = ((chunk?: any, ...args: any[]) => {
    const encoding =
      typeof args[0] === "string" ? (args[0] as BufferEncoding) : undefined;
    bytes += getChunkByteLength(chunk, encoding);
    return originalEnd(chunk, ...args);
  }) as typeof res.end;

  res.once("finish", () => finalize(false));
  res.once("close", () => {
    if (!res.writableFinished) {
      finalize(true);
    }
  });
}
