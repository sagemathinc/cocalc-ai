/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { lookup } from "node:dns/promises";
import { BlockList, connect, isIP, type Socket } from "node:net";
import getLogger from "@cocalc/backend/logger";
import { readClientHelloServerName } from "./tls-client-hello";

const logger = getLogger("project-host:restricted-egress-proxy");
const MAX_TUNNELS_PER_SESSION = 32;
const TUNNEL_IDLE_TIMEOUT_MS = 35 * 60_000;
// Raw connections across all sessions, counted before authentication.
const MAX_CONNECTIONS = 256;
// Absolute deadline from accept until a verified tunnel: the CONNECT request,
// the upstream connection and the client's TLS ClientHello. Trickling bytes
// does not extend it.
const SETUP_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_CLIENT_HELLO_BYTES = 64 * 1024;

type Session = {
  token: string;
  sockets: Set<Socket>;
  activeTunnels: number;
  closed: boolean;
  allowedHosts: ReadonlySet<string>;
  // Also any public host (see isPublicAddress), except deniedHosts.
  publicHosts: boolean;
  deniedHosts: ReadonlySet<string>;
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
  // Whether a session may also open tunnels to any public host. Without it,
  // the allowlist above is absolute.
  allowPublicHostSessions?: boolean;
  maxConnections?: number;
  setupTimeoutMs?: number;
  // Tests substitute a local upstream and name resolution.
  connectUpstream?: (port: number, hostname: string) => Socket;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

// Everything that is not ordinary public unicast: this host and its private
// networks, cloud metadata (169.254.169.254), shared CGNAT space, multicast,
// documentation and benchmarking ranges, and IPv6 equivalents. IPv6 is further
// limited to global unicast (2000::/3) below.
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 can embed any IPv4 address
] as const)
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  return (
    GLOBAL_UNICAST_V6.check(address, "ipv6") &&
    !NON_PUBLIC.check(address, "ipv6")
  );
}

async function resolveHost(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(
    ({ address }) => address,
  );
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
    // One trailing dot (an absolute name) is the same host; anything else
    // with empty labels could slip past exact allow/deny matches.
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const port = Number(parsed.port || 80);
    if (
      !hostname ||
      hostname.split(".").some((label) => label === "") ||
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
  // Raw connections, each with its setup deadline until its tunnel is verified.
  private readonly connections = new Map<
    Socket,
    ReturnType<typeof setTimeout> | undefined
  >();
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
    allowedHosts = this.options.allowedHosts,
    publicHosts = false,
    deniedHosts = new Set(),
  }: {
    host?: string;
    // A session may narrow, but never expand, the proxy allowlist.
    allowedHosts?: ReadonlySet<string>;
    // Only on a proxy constructed with allowPublicHostSessions.
    publicHosts?: boolean;
    // Never reachable through publicHosts.
    deniedHosts?: ReadonlySet<string>;
  } = {}): Promise<RestrictedEgressProxySession> {
    if (publicHosts && !this.options.allowPublicHostSessions)
      throw Error("This egress proxy does not permit public host sessions");
    const port = await this.ensureListening();
    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      token,
      sockets: new Set(),
      activeTunnels: 0,
      closed: false,
      allowedHosts: new Set(allowedHosts),
      publicHosts,
      deniedHosts: new Set(deniedHosts),
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

  /** Bound raw connections before any request parsing or authentication. */
  private admitConnection(socket: Socket): void {
    // A peer may reset at any point, including while a public host resolves
    // or after a rejection; that must close the socket, not the process.
    socket.on("error", () => closeSocket(socket));
    if (
      this.connections.size >= (this.options.maxConnections ?? MAX_CONNECTIONS)
    ) {
      socket.destroy();
      return;
    }
    this.connections.set(
      socket,
      setTimeout(
        () => closeSocket(socket),
        this.options.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
      ),
    );
    socket.once("close", () => {
      clearTimeout(this.connections.get(socket));
      this.connections.delete(socket);
    });
  }

  /** A verified tunnel trades its setup deadline for an idle timeout. */
  private tunnelEstablished(socket: Socket): void {
    clearTimeout(this.connections.get(socket));
    if (this.connections.has(socket)) this.connections.set(socket, undefined);
    socket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => closeSocket(socket));
  }

  /** For tests: raw connections and pending setup deadlines. */
  stateForTesting(): { connections: number; pendingDeadlines: number } {
    return {
      connections: this.connections.size,
      pendingDeadlines: [...this.connections.values()].filter(
        (timer) => timer != null,
      ).length,
    };
  }

  async shutdown(): Promise<void> {
    for (const [socket, timer] of this.connections) {
      clearTimeout(timer);
      closeSocket(socket);
    }
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
    const token = basicProxyToken(request, this.options.username);
    const session = token ? this.sessions.get(token) : undefined;
    if (!session || session.closed) {
      rejectConnect(client, 407, "Proxy Authentication Required");
      return;
    }
    const target = connectTarget(request.url ?? "");
    const listed =
      !!target &&
      this.isAllowedTarget(request.url ?? "") &&
      session.allowedHosts.has(target.hostname);
    if (
      !target ||
      (!listed &&
        (!session.publicHosts ||
          session.deniedHosts.has(target.hostname) ||
          isIP(target.hostname) !== 0))
    ) {
      rejectConnect(client, 403, "Forbidden");
      return;
    }
    if (session.activeTunnels >= MAX_TUNNELS_PER_SESSION) {
      rejectConnect(client, 429, "Too Many Requests");
      return;
    }
    if (listed) {
      this.openTunnel(session, client, head, target, target.hostname);
      return;
    }
    // Resolve here and connect to the vetted address, so a later DNS answer
    // cannot redirect the tunnel to this host's own or private networks.
    session.activeTunnels += 1;
    (this.options.resolveHost ?? resolveHost)(target.hostname)
      .then(
        (addresses) =>
          addresses.length > 0 && addresses.every(isPublicAddress)
            ? addresses[0]
            : undefined,
        () => undefined,
      )
      .then((address) => {
        session.activeTunnels = Math.max(0, session.activeTunnels - 1);
        if (session.closed || client.destroyed) {
          closeSocket(client);
        } else if (!address) {
          rejectConnect(client, 403, "Forbidden");
        } else {
          this.openTunnel(session, client, head, target, address);
        }
      });
  }

  private openTunnel(
    session: Session,
    client: Socket,
    head: Buffer,
    target: { hostname: string; port: number },
    address: string,
  ): void {
    if (session.activeTunnels >= MAX_TUNNELS_PER_SESSION) {
      rejectConnect(client, 429, "Too Many Requests");
      return;
    }
    session.activeTunnels += 1;
    session.sockets.add(client);
    const upstream = (this.options.connectUpstream ?? connect)(
      target.port,
      address,
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
        this.tunnelEstablished(client);
        upstream.write(hello);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
  }

  /**
   * Read the client's ClientHello; call onVerified with the buffered bytes
   * only if it names exactly `hostname`. The connection's setup deadline
   * bounds the wait; a closed client cancels it.
   */
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
      client.off("data", onData);
      client.off("end", onClose);
      client.off("close", onClose);
      if (verified) {
        client.pause();
        onVerified(received);
        return;
      }
      received = Buffer.alloc(0);
      if (reason) {
        logger.debug("restricted egress tunnel rejected", { hostname, reason });
      }
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
    // HTTP server sockets are half-open: a client FIN ends the wait too.
    const onClose = () => finish(false);
    client.on("data", onData);
    client.once("end", onClose);
    client.once("close", onClose);
    check();
  }
}
