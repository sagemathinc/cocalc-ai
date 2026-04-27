/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { IncomingMessage } from "http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import getLogger from "@cocalc/backend/logger";
import type { AppProxyExposureMode } from "@cocalc/backend/auth/app-proxy";

const logger = getLogger("project-host:ws-egress");

const MANAGED_WS_EGRESS_CONTEXT = Symbol("project-host-managed-ws-egress");
const MANAGED_WS_EGRESS_TRACKER = Symbol("project-host-managed-ws-tracker");
const FLUSH_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.COCALC_PROJECT_HOST_WS_EGRESS_FLUSH_MS ?? 5000),
);

export const MANAGED_WS_EGRESS_CATEGORY = "ws-proxy";

export interface ManagedWsEgressContext {
  project_id: string;
  app_id?: string;
  exposure_mode: AppProxyExposureMode;
}

type RecordManagedWsEgressFn = (opts: {
  project_id: string;
  app_id?: string;
  exposure_mode: AppProxyExposureMode;
  bytes: number;
  request_path: string;
  partial: boolean;
}) => Promise<void> | void;

type CheckManagedWsAllowedFn = () => Promise<
  | { allowed: true }
  | {
      allowed: false;
      message: string;
    }
>;

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

export function setManagedWsEgressContext(
  req: IncomingMessage,
  context: ManagedWsEgressContext,
): void {
  (req as any)[MANAGED_WS_EGRESS_CONTEXT] = context;
}

export function clearManagedWsEgressContext(req: IncomingMessage): void {
  delete (req as any)[MANAGED_WS_EGRESS_CONTEXT];
}

function getManagedWsEgressContext(
  req: IncomingMessage,
): ManagedWsEgressContext | undefined {
  return (req as any)[MANAGED_WS_EGRESS_CONTEXT] as
    | ManagedWsEgressContext
    | undefined;
}

export function attachManagedWsEgressRecorder({
  req,
  socket,
  checkAllowed,
  record,
}: {
  req: IncomingMessage;
  socket: Socket | Duplex;
  checkAllowed: CheckManagedWsAllowedFn;
  record: RecordManagedWsEgressFn;
}): void {
  if ((socket as any)[MANAGED_WS_EGRESS_TRACKER]) {
    return;
  }
  const context = getManagedWsEgressContext(req);
  if (!context) {
    return;
  }
  (socket as any)[MANAGED_WS_EGRESS_TRACKER] = true;

  const request_path = getRequestPath(req);
  const originalWrite = socket.write.bind(socket);
  const originalEnd = socket.end.bind(socket);
  let pendingBytes = 0;
  let finalized = false;
  let flushQueue = Promise.resolve();

  const flush = (partial: boolean) => {
    flushQueue = flushQueue
      .catch(() => undefined)
      .then(async () => {
        const bytes = pendingBytes;
        pendingBytes = 0;
        if (bytes > 0) {
          await record({
            ...context,
            bytes,
            request_path,
            partial,
          });
        }
        const allowed = await checkAllowed();
        if (!allowed.allowed && !socket.destroyed) {
          logger.info("closing websocket due to managed egress policy", {
            project_id: context.project_id,
            app_id: context.app_id,
            request_path,
            message: allowed.message,
          });
          socket.destroy();
        }
      })
      .catch((err) => {
        logger.warn("unable to record managed websocket egress", {
          project_id: context.project_id,
          app_id: context.app_id,
          request_path,
          partial,
          err: `${err}`,
        });
      });
    return flushQueue;
  };

  socket.write = ((chunk: any, ...args: any[]) => {
    const encoding =
      typeof args[0] === "string" ? (args[0] as BufferEncoding) : undefined;
    pendingBytes += getChunkByteLength(chunk, encoding);
    return originalWrite(chunk, ...args);
  }) as typeof socket.write;

  socket.end = ((chunk?: any, ...args: any[]) => {
    const encoding =
      typeof args[0] === "string" ? (args[0] as BufferEncoding) : undefined;
    pendingBytes += getChunkByteLength(chunk, encoding);
    return originalEnd(chunk, ...args);
  }) as typeof socket.end;

  const timer = setInterval(() => {
    if (socket.destroyed || finalized) {
      clearInterval(timer);
      return;
    }
    void flush(false);
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    clearInterval(timer);
    void flush(true);
  };

  socket.once("close", finalize);
  socket.once("error", finalize);
  socket.once("end", finalize);
}
