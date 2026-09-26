/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";

const MAX_REQUEST_BYTES = 128 * 1024 * 1024;
const RELAY_HEADER = "x-cocalc-credential-relay";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface CredentialHttpRelayOptions {
  socketPath: string;
  upstream: string;
  allowedPathPrefix: string;
  credential: { header: string; value: string };
  /** Revalidate the exact credential for each request, including retained sessions. */
  authorize?: () => Promise<string>;
  allowedMethods?: readonly string[];
  /** Tests only. Production provider relays must use HTTPS. */
  allowHttpForTests?: boolean;
}

export interface CredentialHttpRelay {
  socketPath: string;
  token: string;
  close(): Promise<void>;
}

function safeHeaders(
  source: IncomingHttpHeaders,
  credentialHeader: string,
): IncomingHttpHeaders {
  const target: IncomingHttpHeaders = {};
  const blocked = new Set([
    ...HOP_BY_HOP_HEADERS,
    "host",
    RELAY_HEADER,
    "authorization",
    "x-api-key",
    credentialHeader.toLowerCase(),
  ]);
  for (const [name, value] of Object.entries(source)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) {
      target[name] = value;
    }
  }
  return target;
}

function fail(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ error: message }));
}

function forwardResponse(upstream: IncomingMessage, response: ServerResponse) {
  const headers = safeHeaders(upstream.headers, "");
  response.writeHead(upstream.statusCode ?? 502, headers);
  upstream.pipe(response);
}

export async function createCredentialHttpRelay(
  options: CredentialHttpRelayOptions,
): Promise<CredentialHttpRelay> {
  const upstream = new URL(options.upstream);
  if (
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    (upstream.protocol !== "https:" &&
      !(options.allowHttpForTests && upstream.protocol === "http:"))
  ) {
    throw Error("Credential relay upstream must be a fixed HTTPS origin");
  }
  if (
    !options.allowedPathPrefix.startsWith("/") ||
    options.allowedPathPrefix.includes("..") ||
    !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(options.credential.header) ||
    !options.credential.value ||
    /[\r\n]/.test(options.credential.value)
  ) {
    throw Error("Invalid credential relay policy");
  }
  const token = randomBytes(32).toString("base64url");
  const allowedMethods = new Set(
    (options.allowedMethods ?? ["GET", "POST"]).map((method) =>
      method.toUpperCase(),
    ),
  );
  if (
    allowedMethods.size === 0 ||
    [...allowedMethods].some((method) => !/^[A-Z]+$/.test(method))
  ) {
    throw Error("Invalid credential relay methods");
  }
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  let closing = false;
  const requests = new Set<ClientRequest>();
  const server = createServer((request, response) => {
    void forward(request, response).catch(() => {
      request.resume();
      fail(response, 403, "Credential is unavailable or revoked");
    });
  });
  async function forward(request: IncomingMessage, response: ServerResponse) {
    if (request.headers[RELAY_HEADER] !== token) {
      request.resume();
      fail(response, 401, "Credential relay authorization failed");
      return;
    }
    if (!request.method || !allowedMethods.has(request.method.toUpperCase())) {
      request.resume();
      fail(response, 405, "Provider request method is outside relay policy");
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "", upstream);
    } catch {
      request.resume();
      fail(response, 400, "Invalid provider request");
      return;
    }
    if (
      target.origin !== upstream.origin ||
      !target.pathname.startsWith(options.allowedPathPrefix)
    ) {
      request.resume();
      fail(response, 403, "Provider request is outside relay policy");
      return;
    }
    const headers = safeHeaders(request.headers, options.credential.header);
    headers.host = upstream.host;
    headers[options.credential.header] = options.authorize
      ? await options.authorize()
      : options.credential.value;
    if (closing || request.destroyed) throw Error("Relay is closed");
    const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    let sent = 0;
    let providerRequest: ClientRequest;
    try {
      providerRequest = send(
        target,
        { method: request.method, headers },
        (providerResponse) => forwardResponse(providerResponse, response),
      );
    } catch {
      request.resume();
      fail(response, 502, "Provider request could not be started");
      return;
    }
    providerRequest.setTimeout(10 * 60_000, () =>
      providerRequest.destroy(Error("provider timeout")),
    );
    requests.add(providerRequest);
    providerRequest.once("close", () => requests.delete(providerRequest));
    request.on("data", (chunk: Buffer) => {
      sent += chunk.length;
      if (sent > MAX_REQUEST_BYTES) {
        providerRequest.destroy(Error("request too large"));
        request.destroy();
      }
    });
    request.on("error", () => providerRequest.destroy());
    providerRequest.on("error", () =>
      fail(
        response,
        sent > MAX_REQUEST_BYTES ? 413 : 502,
        "Provider unavailable",
      ),
    );
    request.pipe(providerRequest);
  }
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(options.socketPath, 0o600);
  let closed: Promise<void> | undefined;
  return {
    socketPath: options.socketPath,
    token,
    close: () =>
      (closed ??= new Promise<void>((resolve, reject) => {
        closing = true;
        for (const request of requests) request.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }).finally(() =>
        unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        }),
      )),
  };
}

export const CREDENTIAL_RELAY_AUTH_HEADER = RELAY_HEADER;
