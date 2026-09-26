/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createServer, request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialHttpRelay } from "./credential-http-relay";
import { createCredentialRelayBridge } from "./credential-relay-bridge";

test("bridges a provider URL without exposing the durable key", async () => {
  let providerKey: string | string[] | undefined;
  const provider = createServer((request, response) => {
    providerKey = request.headers["x-api-key"];
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (!address || typeof address === "string") throw Error("missing port");
  const directory = await mkdtemp(join(tmpdir(), "cocalc-bridge-test-"));
  const relay = await createCredentialHttpRelay({
    socketPath: join(directory, "provider.sock"),
    upstream: `http://127.0.0.1:${address.port}`,
    allowedPathPrefix: "/v1/",
    credential: { header: "x-api-key", value: "durable-secret" },
    allowHttpForTests: true,
  });
  const bridge = await createCredentialRelayBridge(relay);
  try {
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = request(
          `${bridge.baseUrl}/v1/models`,
          { headers: { "x-api-key": "sidecar-placeholder" } },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.once("error", reject);
        req.end();
      },
    );
    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
    expect(providerKey).toBe("durable-secret");
    expect(JSON.stringify(relay)).not.toContain("durable-secret");
    expect(bridge.baseUrl).not.toContain(relay.token);
  } finally {
    await bridge.close();
    await relay.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test("a bridge capability expires when its host relay closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-bridge-test-"));
  const relay = await createCredentialHttpRelay({
    socketPath: join(directory, "provider.sock"),
    upstream: "http://127.0.0.1:9",
    allowedPathPrefix: "/v1/",
    credential: { header: "x-api-key", value: "durable-secret" },
    allowHttpForTests: true,
  });
  const bridge = await createCredentialRelayBridge(relay);
  await relay.close();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${bridge.baseUrl}/v1/models`, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      req.once("error", reject);
      req.end();
    });
    expect(status).toBe(502);
  } finally {
    await bridge.close();
  }
});
