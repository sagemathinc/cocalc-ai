/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createServer, connect, type Server, type Socket } from "node:net";
import listen from "@cocalc/backend/misc/async-server-listen";
import getLogger from "@cocalc/backend/logger";
import {
  canonicalizeSshRemoteAddrParts,
  canonicalizeSshRemoteAddr,
} from "./ssh-remote-addr";

const logger = getLogger("project-proxy:ssh:edge-proxy");
const FLUSH_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.COCALC_PROJECT_HOST_SSH_EGRESS_FLUSH_MS ?? 5000),
);

export interface ManagedSshEgressIdentity {
  remote_addr: string;
  project_id: string;
  account_id?: string;
}

function stripIpv4Mapped(host: string): string {
  return host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
}

function buildProxyHeader(client: Socket): string {
  const remoteAddress = `${client.remoteAddress ?? ""}`.trim();
  const localAddress = `${client.localAddress ?? ""}`.trim();
  const remotePort = Number(client.remotePort ?? 0);
  const localPort = Number(client.localPort ?? 0);
  if (!remoteAddress || !localAddress || !remotePort || !localPort) {
    return "PROXY UNKNOWN\r\n";
  }
  const src = stripIpv4Mapped(remoteAddress);
  const dst = stripIpv4Mapped(localAddress);
  const srcIsIpv6 = src.includes(":");
  const dstIsIpv6 = dst.includes(":");
  if (srcIsIpv6 !== dstIsIpv6) {
    return "PROXY UNKNOWN\r\n";
  }
  const proto = srcIsIpv6 ? "TCP6" : "TCP4";
  return `PROXY ${proto} ${src} ${dst} ${remotePort} ${localPort}\r\n`;
}

function getRemoteAddr(client: Socket): string {
  return canonicalizeSshRemoteAddrParts(
    `${client.remoteAddress ?? ""}`.trim(),
    Number(client.remotePort ?? 0),
  );
}

export async function startManagedSshEdgeProxy({
  port,
  host = "0.0.0.0",
  upstreamPort,
  flush_interval_ms = FLUSH_INTERVAL_MS,
  getIdentity,
  clearIdentity,
  checkAllowed,
  record,
}: {
  port: number;
  host?: string;
  upstreamPort: number;
  flush_interval_ms?: number;
  getIdentity: (remote_addr: string) => ManagedSshEgressIdentity | undefined;
  clearIdentity: (remote_addr: string) => void;
  checkAllowed: (identity: ManagedSshEgressIdentity) => Promise<
    | { allowed: true }
    | {
        allowed: false;
        message: string;
      }
  >;
  record: (opts: {
    remote_addr: string;
    project_id: string;
    account_id?: string;
    bytes: number;
    partial: boolean;
  }) => Promise<void> | void;
}): Promise<Server> {
  const server = createServer((client) => {
    let remote_addr: string;
    try {
      remote_addr = getRemoteAddr(client);
    } catch (err) {
      logger.warn("unable to derive ssh remote address", { err: `${err}` });
      client.destroy();
      return;
    }

    const upstream = connect({
      host: "127.0.0.1",
      port: upstreamPort,
    });
    const proxyHeader = buildProxyHeader(client);
    const originalWrite = client.write.bind(client);
    let pendingBytes = 0;
    let finalized = false;
    let flushQueue = Promise.resolve();

    const flush = (partial: boolean) => {
      flushQueue = flushQueue
        .catch(() => undefined)
        .then(async () => {
          if (!(pendingBytes > 0)) return;
          const identity = getIdentity(remote_addr);
          if (!identity) return;
          const bytes = pendingBytes;
          pendingBytes = 0;
          await record({
            ...identity,
            remote_addr,
            bytes,
            partial,
          });
          const allowed = await checkAllowed(identity);
          if (!allowed.allowed && !client.destroyed) {
            logger.info("closing ssh session due to managed egress policy", {
              remote_addr,
              project_id: identity.project_id,
              account_id: identity.account_id,
              message: allowed.message,
            });
            client.destroy();
            upstream.destroy();
          }
        })
        .catch((err) => {
          logger.warn("unable to record managed ssh egress", {
            remote_addr,
            partial,
            err: `${err}`,
          });
        });
      return flushQueue;
    };

    client.write = ((chunk: any, ...args: any[]) => {
      if (typeof chunk === "string") {
        const encoding =
          typeof args[0] === "string" ? (args[0] as BufferEncoding) : undefined;
        pendingBytes += Buffer.byteLength(chunk, encoding);
      } else if (Buffer.isBuffer(chunk)) {
        pendingBytes += chunk.length;
      } else if (chunk instanceof ArrayBuffer) {
        pendingBytes += chunk.byteLength;
      } else if (ArrayBuffer.isView(chunk)) {
        pendingBytes += chunk.byteLength;
      }
      return originalWrite(chunk, ...args);
    }) as typeof client.write;

    const timer = setInterval(() => {
      if (finalized || client.destroyed) {
        clearInterval(timer);
        return;
      }
      void flush(false);
    }, flush_interval_ms);
    timer.unref?.();

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      clearInterval(timer);
      void flush(true).finally(() => clearIdentity(remote_addr));
    };

    upstream.once("connect", () => {
      upstream.write(proxyHeader);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", (err) => {
      logger.debug("ssh upstream proxy error", { remote_addr, err: `${err}` });
      client.destroy();
    });
    client.on("error", (err) => {
      logger.debug("ssh downstream client error", {
        remote_addr,
        err: `${err}`,
      });
      upstream.destroy();
    });
    upstream.once("close", () => {
      client.destroy();
    });
    client.once("close", finalize);
    upstream.once("close", finalize);
  });

  await listen({
    server,
    port,
    host,
    desc: "project ssh ingress edge proxy",
  });

  return server;
}

export function canonicalizeManagedSshRemoteAddr(value: string): string {
  return canonicalizeSshRemoteAddr(value);
}
