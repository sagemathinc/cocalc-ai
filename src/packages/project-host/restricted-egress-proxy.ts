/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-host:restricted-egress-proxy");
const MAX_TUNNELS_PER_SESSION = 32;
const TUNNEL_IDLE_TIMEOUT_MS = 35 * 60_000;

type Session = {
  token: string;
  sockets: Set<Socket>;
  activeTunnels: number;
  closed: boolean;
};

export type RestrictedEgressProxySession = {
  proxyUrl: string;
  close: () => void;
};

export interface RestrictedEgressProxyOptions {
  // For logs only.
  name: string;
  // Proxy-Authorization user name; the per-session token is the password.
  username: string;
  // Exact host names (TLS on port 443 only). Keep these deliberately narrow.
  allowedHosts: ReadonlySet<string>;
}

function closeSocket(socket: Socket): void {
  if (!socket.destroyed) socket.destroy();
}

function rejectConnect(socket: Socket, status: number, message: string): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

function basicProxyToken(
  request: IncomingMessage,
  username: string,
): string | undefined {
  const authorization = `${request.headers["proxy-authorization"] ?? ""}`;
  const match = /^Basic\s+(.+)$/i.exec(authorization);
  if (!match) return;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0 || decoded.slice(0, separator) !== username) return;
    return decoded.slice(separator + 1);
  } catch {
    return;
  }
}

function connectTarget(rawTarget: string): {
  hostname: string;
  port: number;
} | null {
  try {
    const parsed = new URL(`http://${rawTarget}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const port = Number(parsed.port || 80);
    if (
      !hostname ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      port !== 443
    ) {
      return null;
    }
    return { hostname, port };
  } catch {
    return null;
  }
}

/**
 * An authenticated HTTP CONNECT proxy on the project host that tunnels only to
 * an allowlist of TLS hosts. It lets one agent runtime reach its provider when
 * general egress from the project is disabled. All sessions share a listener.
 */
export class RestrictedEgressProxy {
  constructor(private readonly options: RestrictedEgressProxyOptions) {}

  isAllowedTarget(rawTarget: string): boolean {
    const target = connectTarget(rawTarget);
    return !!target && this.options.allowedHosts.has(target.hostname);
  }

  private readonly sessions = new Map<string, Session>();
  private server?: ReturnType<typeof createServer>;
  private port?: number;
  private listening?: Promise<number>;

  private async ensureListening(): Promise<number> {
    if (this.port != null) return this.port;
    if (this.listening) return await this.listening;
    this.listening = this.startListening();
    try {
      return await this.listening;
    } finally {
      this.listening = undefined;
    }
  }

  private async startListening(): Promise<number> {
    if (!this.server) {
      this.server = createServer((_request, response) => {
        response.writeHead(405, { connection: "close" });
        response.end();
      });
      this.server.on("connect", (request, socket, head) => {
        this.handleConnect(request, socket as Socket, head);
      });
      this.server.on("clientError", (_err, socket) =>
        closeSocket(socket as Socket),
      );
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server?.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server!.once("error", onError);
      this.server!.once("listening", onListening);
      // Containers reach this through host.containers.internal or the host's
      // own address. The random session credential is required for every tunnel.
      this.server!.listen(0, "0.0.0.0");
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error(
        `failed to determine restricted ${this.options.name} proxy port`,
      );
    }
    this.port = address.port;
    this.server.unref();
    logger.info("restricted egress proxy listening", {
      name: this.options.name,
      port: this.port,
    });
    return this.port;
  }

  /** `host` is how the client container reaches this host. */
  async startSession({
    host = "host.containers.internal",
  }: { host?: string } = {}): Promise<RestrictedEgressProxySession> {
    const port = await this.ensureListening();
    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      token,
      sockets: new Set(),
      activeTunnels: 0,
      closed: false,
    };
    this.sessions.set(token, session);
    return {
      proxyUrl: `http://${this.options.username}:${token}@${host.includes(":") ? `[${host}]` : host}:${port}`,
      close: () => {
        if (session.closed) return;
        session.closed = true;
        this.sessions.delete(token);
        for (const socket of session.sockets) closeSocket(socket);
        session.sockets.clear();
      },
    };
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.closed = true;
      for (const socket of session.sockets) closeSocket(socket);
    }
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handleConnect(
    request: IncomingMessage,
    client: Socket,
    head: Buffer,
  ): void {
    const token = basicProxyToken(request, this.options.username);
    const session = token ? this.sessions.get(token) : undefined;
    if (!session || session.closed) {
      rejectConnect(client, 407, "Proxy Authentication Required");
      return;
    }
    const target = connectTarget(request.url ?? "");
    if (!target || !this.isAllowedTarget(request.url ?? "")) {
      rejectConnect(client, 403, "Forbidden");
      return;
    }
    if (session.activeTunnels >= MAX_TUNNELS_PER_SESSION) {
      rejectConnect(client, 429, "Too Many Requests");
      return;
    }

    session.activeTunnels += 1;
    session.sockets.add(client);
    const upstream = connect(target.port, target.hostname);
    session.sockets.add(upstream);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      session.activeTunnels = Math.max(0, session.activeTunnels - 1);
      session.sockets.delete(client);
      session.sockets.delete(upstream);
    };
    client.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => closeSocket(client));
    upstream.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => closeSocket(upstream));
    client.once("close", () => {
      release();
      closeSocket(upstream);
    });
    upstream.once("close", () => {
      release();
      closeSocket(client);
    });
    client.once("error", () => closeSocket(upstream));
    upstream.once("error", () => {
      if (!client.destroyed) rejectConnect(client, 502, "Bad Gateway");
    });
    upstream.once("connect", () => {
      if (session.closed || client.destroyed) {
        closeSocket(upstream);
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }
}
