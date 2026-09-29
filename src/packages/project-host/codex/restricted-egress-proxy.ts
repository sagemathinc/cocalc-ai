/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import getLogger from "@cocalc/backend/logger";
import { readClientHelloServerName } from "./tls-client-hello";

const logger = getLogger("project-host:codex:restricted-egress-proxy");
const PROXY_USERNAME = "cocalc-codex";
const MAX_TUNNELS_PER_SESSION = 32;
const TUNNEL_IDLE_TIMEOUT_MS = 35 * 60_000;
// Raw connections across all sessions, counted before authentication.
const MAX_CONNECTIONS = 256;
// A client must finish its CONNECT request, and later its TLS ClientHello,
// within these bounds.
const PREAUTH_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 8 * 1024;
const CLIENT_HELLO_TIMEOUT_MS = 10_000;
const MAX_CLIENT_HELLO_BYTES = 64 * 1024;

// Keep this deliberately narrow. This proxy exists only so Codex authentication
// and provider traffic continue to work when general project egress is disabled.
const ALLOWED_OPENAI_HOSTS = new Set([
  "api.openai.com",
  "auth.openai.com",
  "chat.openai.com",
  "chatgpt.com",
  "files.openai.com",
]);

type Session = {
  token: string;
  sockets: Set<Socket>;
  activeTunnels: number;
  closed: boolean;
};

export type RestrictedCodexEgressProxySession = {
  proxyUrl: string;
  close: () => void;
};

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

function basicProxyToken(request: IncomingMessage): string | undefined {
  const authorization = `${request.headers["proxy-authorization"] ?? ""}`;
  const match = /^Basic\s+(.+)$/i.exec(authorization);
  if (!match) return;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0 || decoded.slice(0, separator) !== PROXY_USERNAME) return;
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

export function isAllowedCodexEgressTarget(rawTarget: string): boolean {
  const target = connectTarget(rawTarget);
  return !!target && ALLOWED_OPENAI_HOSTS.has(target.hostname);
}

export interface RestrictedCodexEgressProxyOptions {
  maxConnections?: number;
  preauthTimeoutMs?: number;
  clientHelloTimeoutMs?: number;
  // Tests substitute a local upstream.
  connectUpstream?: (port: number, hostname: string) => Socket;
}

export class RestrictedCodexEgressProxy {
  constructor(
    private readonly options: RestrictedCodexEgressProxyOptions = {},
  ) {}

  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Set<Socket>();
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
      this.server = createServer(
        { maxHeaderSize: MAX_HEADER_BYTES },
        (_request, response) => {
          response.writeHead(405, { connection: "close" });
          response.end();
        },
      );
      this.server.on("connection", (socket: Socket) =>
        this.admitConnection(socket),
      );
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
      // Project containers reach this through host.containers.internal. The
      // random session credential is still required for every tunnel.
      this.server!.listen(0, "0.0.0.0");
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to determine restricted Codex proxy port");
    }
    this.port = address.port;
    this.server.unref();
    logger.info("restricted Codex egress proxy listening", { port: this.port });
    return this.port;
  }

  async startSession(): Promise<RestrictedCodexEgressProxySession> {
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
      proxyUrl: `http://${PROXY_USERNAME}:${token}@host.containers.internal:${port}`,
      close: () => {
        if (session.closed) return;
        session.closed = true;
        this.sessions.delete(token);
        for (const socket of session.sockets) closeSocket(socket);
        session.sockets.clear();
      },
    };
  }

  /** Bound raw connections before any request parsing or authentication. */
  private admitConnection(socket: Socket): void {
    if (
      this.connections.size >= (this.options.maxConnections ?? MAX_CONNECTIONS)
    ) {
      socket.destroy();
      return;
    }
    this.connections.add(socket);
    socket.once("close", () => this.connections.delete(socket));
    // Replaced by the tunnel idle timeout once a tunnel is established.
    socket.setTimeout(this.options.preauthTimeoutMs ?? PREAUTH_TIMEOUT_MS, () =>
      closeSocket(socket),
    );
  }

  async shutdown(): Promise<void> {
    for (const socket of this.connections) closeSocket(socket);
    this.connections.clear();
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
    const token = basicProxyToken(request);
    const session = token ? this.sessions.get(token) : undefined;
    if (!session || session.closed) {
      rejectConnect(client, 407, "Proxy Authentication Required");
      return;
    }
    const target = connectTarget(request.url ?? "");
    if (!target || !isAllowedCodexEgressTarget(request.url ?? "")) {
      rejectConnect(client, 403, "Forbidden");
      return;
    }
    if (session.activeTunnels >= MAX_TUNNELS_PER_SESSION) {
      rejectConnect(client, 429, "Too Many Requests");
      return;
    }

    session.activeTunnels += 1;
    session.sockets.add(client);
    const upstream = (this.options.connectUpstream ?? connect)(
      target.port,
      target.hostname,
    );
    session.sockets.add(upstream);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      session.activeTunnels = Math.max(0, session.activeTunnels - 1);
      session.sockets.delete(client);
      session.sockets.delete(upstream);
    };
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
      // The CONNECT authority only names the address; shared CDN addresses
      // serve many sites. Forward nothing until the client's own TLS
      // ClientHello asks for exactly the allowed host.
      this.awaitClientHello(client, head, target.hostname, (hello) => {
        if (session.closed || client.destroyed || upstream.destroyed) {
          closeSocket(client);
          return;
        }
        client.setTimeout(TUNNEL_IDLE_TIMEOUT_MS);
        upstream.write(hello);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
  }

  private awaitClientHello(
    client: Socket,
    head: Buffer,
    hostname: string,
    onVerified: (hello: Buffer) => void,
  ): void {
    let received = head;
    let finished = false;
    const finish = (verified: boolean, reason?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      client.off("data", onData);
      if (verified) {
        client.pause();
        onVerified(received);
        return;
      }
      logger.debug("restricted egress tunnel rejected", { hostname, reason });
      closeSocket(client);
    };
    const check = () => {
      if (received.length > MAX_CLIENT_HELLO_BYTES)
        return finish(false, "ClientHello too large");
      const hello = readClientHelloServerName(received);
      if (hello.state === "incomplete") return;
      if (hello.state === "invalid") return finish(false, hello.reason);
      finish(
        hello.serverName === hostname,
        hello.serverName === hostname ? undefined : "server name mismatch",
      );
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      check();
    };
    const timer = setTimeout(
      () => finish(false, "ClientHello timeout"),
      this.options.clientHelloTimeoutMs ?? CLIENT_HELLO_TIMEOUT_MS,
    );
    client.on("data", onData);
    check();
  }
}

const proxy = new RestrictedCodexEgressProxy();

export function startRestrictedCodexEgressProxySession(): Promise<RestrictedCodexEgressProxySession> {
  return proxy.startSession();
}

export function shutdownRestrictedCodexEgressProxyForTesting(): Promise<void> {
  return proxy.shutdown();
}
