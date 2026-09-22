/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { CREDENTIAL_RELAY_AUTH_HEADER } from "./credential-http-relay";

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

function forwardHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) &&
      name.toLowerCase() !== CREDENTIAL_RELAY_AUTH_HEADER
    ) {
      headers[name] = value;
    }
  }
  return headers;
}

export interface CredentialRelayBridge {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Expose a provider-compatible loopback URL without placing the durable
 * provider credential in the sidecar. The capability is useful only while the
 * corresponding host relay is alive.
 */
export async function createCredentialRelayBridge({
  socketPath,
  token,
}: {
  socketPath: string;
  token: string;
}): Promise<CredentialRelayBridge> {
  if (!socketPath.startsWith("/") || !token || /[\r\n]/.test(token)) {
    throw Error("Invalid credential relay binding");
  }
  const server = createServer((request, response) => {
    const headers = forwardHeaders(request.headers);
    headers[CREDENTIAL_RELAY_AUTH_HEADER] = token;
    const relayRequest = httpRequest(
      {
        socketPath,
        path: request.url,
        method: request.method,
        headers,
      },
      (relayResponse) => {
        response.writeHead(
          relayResponse.statusCode ?? 502,
          forwardHeaders(relayResponse.headers),
        );
        relayResponse.pipe(response);
      },
    );
    request.on("error", () => relayRequest.destroy());
    relayRequest.on("error", () => {
      if (response.headersSent) return response.destroy();
      response.writeHead(502, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "Credential relay unavailable" }));
    });
    request.pipe(relayRequest);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw Error("Credential relay bridge did not bind TCP");
  }
  let closed: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      (closed ??= new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )),
  };
}
