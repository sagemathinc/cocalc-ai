/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createServer, request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIAL_RELAY_AUTH_HEADER,
  createCredentialHttpRelay,
} from "./credential-http-relay";

async function callRelay({
  socketPath,
  token,
  path = "/v1/messages?beta=1",
  method = "POST",
}: {
  socketPath: string;
  token: string;
  path?: string;
  method?: string;
}): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: {
          [CREDENTIAL_RELAY_AUTH_HEADER]: token,
          "x-api-key": "attacker-key",
          authorization: "Bearer attacker",
          "content-type": "application/json",
        },
      },
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
    req.end('{"prompt":"hello"}');
  });
}

test("injects the account credential only for the fixed provider origin", async () => {
  let received: Record<string, unknown> | undefined;
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        url: request.url,
        key: request.headers["x-api-key"],
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: ok\n\n");
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (!address || typeof address === "string") throw Error("missing port");
  const directory = await mkdtemp(join(tmpdir(), "cocalc-relay-test-"));
  const relay = await createCredentialHttpRelay({
    socketPath: join(directory, "provider.sock"),
    upstream: `http://127.0.0.1:${address.port}`,
    allowedPathPrefix: "/v1/",
    credential: { header: "x-api-key", value: "real-account-key" },
    allowHttpForTests: true,
  });
  try {
    await expect(callRelay(relay)).resolves.toEqual({
      status: 200,
      body: "data: ok\n\n",
    });
    expect(received).toEqual({
      url: "/v1/messages?beta=1",
      key: "real-account-key",
      authorization: undefined,
      body: '{"prompt":"hello"}',
    });
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test("retained relay revalidates rotation and revocation before provider requests", async () => {
  const keys: unknown[] = [];
  const provider = createServer((request, response) => {
    keys.push(request.headers["x-api-key"]);
    request.resume();
    response.end("ok");
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address() as { port: number };
  const directory = await mkdtemp(join(tmpdir(), "cocalc-relay-test-"));
  let current: string | undefined = "rotated-fixture";
  const relay = await createCredentialHttpRelay({
    socketPath: join(directory, "provider.sock"),
    upstream: `http://127.0.0.1:${address.port}`,
    allowedPathPrefix: "/v1/",
    credential: { header: "x-api-key", value: "old-fixture" },
    authorize: async () => {
      if (!current) throw Error("revoked");
      return current;
    },
    allowHttpForTests: true,
  });
  try {
    expect((await callRelay(relay)).status).toBe(200);
    current = undefined;
    expect((await callRelay(relay)).status).toBe(403);
    expect(keys).toEqual(["rotated-fixture"]);
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test("rejects invalid capabilities and off-policy request targets", async () => {
  const provider = createServer((_request, response) => response.end("bad"));
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (!address || typeof address === "string") throw Error("missing port");
  const directory = await mkdtemp(join(tmpdir(), "cocalc-relay-test-"));
  const relay = await createCredentialHttpRelay({
    socketPath: join(directory, "provider.sock"),
    upstream: `http://127.0.0.1:${address.port}`,
    allowedPathPrefix: "/v1/",
    credential: { header: "x-api-key", value: "real-account-key" },
    allowHttpForTests: true,
  });
  try {
    await expect(
      callRelay({ ...relay, token: "wrong" }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      callRelay({ ...relay, path: "/admin", token: relay.token }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      callRelay({ ...relay, method: "DELETE", token: relay.token }),
    ).resolves.toMatchObject({ status: 405 });
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
