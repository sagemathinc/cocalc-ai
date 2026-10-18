/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Load the capability module from source, so this test does not depend on a
// prior build of @cocalc/conat.
jest.mock(
  "@cocalc/conat/auth/project-content-capability",
  () => jest.requireActual("../conat/auth/project-content-capability"),
  { virtual: true },
);

import { generateKeyPairSync } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { issueProjectContentCapability } from "@cocalc/conat/auth/project-content-capability";
import {
  createContentOriginHandler,
  installContentHostnameUpgradeGuard,
  parseContentPath,
  projectContentHostname,
} from "./content-origin";

const domain = "usercontent.example.org";
const hostId = "00000000-0000-4000-8000-000000000001";
const otherHostId = "00000000-0000-4000-8000-000000000006";
const projectA = "00000000-0000-4000-8000-00000000000a";
const projectB = "00000000-0000-4000-8000-00000000000b";
const member = "00000000-0000-4000-8000-000000000002";
const outsider = "00000000-0000-4000-8000-000000000003";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const hostA = projectContentHostname({ project_id: projectA, host_id: hostId, domain });
const hostB = projectContentHostname({ project_id: projectB, host_id: hostId, domain });

function cap(extra: Record<string, unknown> = {}): string {
  return issueProjectContentCapability({
    project_id: projectA,
    host_id: hostId,
    account_id: member,
    epoch: 0,
    private_key: privateKeyPem,
    ...extra,
  }).token;
}

interface Served {
  url?: string;
  project_id: string;
  account_id: string;
  cookie?: string;
  authorization?: string;
}

let server: Server;
let port: number;
let served: Served[];
let passedOn: string[];
let epoch: number;
let errors: unknown[];

beforeEach(async () => {
  served = [];
  passedOn = [];
  errors = [];
  epoch = 0;
  const handler = createContentOriginHandler({
    domain,
    host_id: hostId,
    getPublicKey: () => publicKeyPem,
    frameAncestors: () => ["https://app.example.org"],
    hasReadAccess: ({ account_id, project_id }) =>
      account_id === member && (project_id === projectA || project_id === projectB),
    currentEpoch: () => epoch,
    serveFile: async ({ req, res, project_id, account_id }) => {
      served.push({
        url: req.url,
        project_id,
        account_id,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
      });
      res.setHeader("Set-Cookie", "tossed=1");
      res.setHeader("Content-Type", "text/html");
      res.end("<p>benign</p>");
    },
    onError: ({ err }) => errors.push(err),
  });
  server = createServer((req, res) => {
    void handler(req, res, () => {
      passedOn.push(`${req.headers.host} ${req.url}`);
      res.statusCode = 299;
      res.end("host route");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function get(
  host: string,
  path: string,
  { method = "GET", headers = {} }: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { host, ...headers } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("content origin request handling", () => {
  it("serves a project file read as the capability's account, with no credentials", async () => {
    const r = await get(hostA, `/_c/${cap()}/files/dir/page.html?v=1`, {
      headers: { cookie: "cocalc_project_host_http_session=x", authorization: "Bearer y" },
    });
    expect(r.status).toBe(200);
    expect(served).toEqual([
      {
        url: `/${projectA}/files/dir/page.html`,
        project_id: projectA,
        account_id: member,
        cookie: undefined,
        authorization: undefined,
      },
    ]);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["origin-agent-cluster"]).toBe("?1");
    expect(r.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.headers["content-security-policy"]).toBe(
      "frame-ancestors 'self' https://app.example.org",
    );
  });

  it("never serves project A's capability under project B's origin", async () => {
    const r = await get(hostB, `/_c/${cap()}/files/page.html`);
    expect(r.status).toBe(403);
    expect(served).toEqual([]);
  });

  it("answers only for this host's label", async () => {
    const elsewhere = projectContentHostname({ project_id: projectA, host_id: otherHostId, domain });
    const r = await get(elsewhere, `/_c/${cap()}/files/page.html`);
    expect(r.status).toBe(404);
    expect(served).toEqual([]);
  });

  it("never passes a content-hostname request to the host's own routes", async () => {
    for (const path of [`/${projectA}/files/page.html`, "/healthz", "/conat/x", "/"]) {
      const r = await get(hostA, path);
      expect(r.status).toBe(404);
    }
    expect((await get(domain, "/healthz")).status).toBe(404);
    expect(passedOn).toEqual([]);
    expect(served).toEqual([]);
  });

  it("leaves requests on other hostnames to the host's routes", async () => {
    const r = await get("host-1.example.org", `/_c/${cap()}/files/page.html`);
    expect(r.status).toBe(299);
    expect(passedOn).toHaveLength(1);
    expect(served).toEqual([]);
  });

  it("refuses a revoked (stale epoch) capability and a non-member", async () => {
    epoch = 1;
    expect((await get(hostA, `/_c/${cap()}/files/page.html`)).status).toBe(403);
    epoch = 0;
    expect(
      (await get(hostA, `/_c/${cap({ account_id: outsider })}/files/page.html`)).status,
    ).toBe(403);
    expect(served).toEqual([]);
  });

  it("refuses service workers, writes, malformed capabilities and dot segments", async () => {
    const c = cap();
    expect(
      (await get(hostA, `/_c/${c}/files/sw.js`, { headers: { "service-worker": "script" } }))
        .status,
    ).toBe(403);
    expect((await get(hostA, `/_c/${c}/files/page.html`, { method: "POST" })).status).toBe(405);
    expect((await get(hostA, `/_c/not-a-token/files/page.html`)).status).toBe(403);
    expect((await get(hostA, `/_c/${c}/files/a/%2e%2e/b.html`)).status).toBe(404);
    expect((await get(hostA, `/_c/${c}/other/page.html`)).status).toBe(404);
    expect(served).toEqual([]);
  });

  it("parses only /_c/<capability>/files/<path>", () => {
    expect(parseContentPath("/_c/a.b.c/files/x/y.html?q#h")).toEqual({
      capability: "a.b.c",
      filePath: "x/y.html",
    });
    expect(parseContentPath("/_c/a.b.c/files/")).toBeUndefined();
    expect(parseContentPath("/_c//files/x")).toBeUndefined();
    expect(parseContentPath("/_c/a.b.c/files/../x")).toBeUndefined();
    expect(parseContentPath("/x/_c/a.b.c/files/y")).toBeUndefined();
  });
});

describe("content hostname upgrade guard", () => {
  it("refuses websocket upgrades on content hostnames before any listener runs", async () => {
    const upgrades: string[] = [];
    installContentHostnameUpgradeGuard(server, domain);
    server.on("upgrade", (req, socket) => {
      upgrades.push(`${req.headers.host}`);
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    const tryUpgrade = (host: string) =>
      new Promise<string>((resolve) => {
        const req = request({
          host: "127.0.0.1",
          port,
          path: "/conat/",
          headers: { host, connection: "Upgrade", upgrade: "websocket" },
        });
        req.on("upgrade", () => resolve("upgraded"));
        req.on("error", () => resolve("closed"));
        req.on("close", () => resolve("closed"));
        req.end();
      });
    expect(await tryUpgrade(hostA)).toBe("closed");
    expect(upgrades).toEqual([]);
    expect(await tryUpgrade("host-1.example.org")).toBe("upgraded");
    expect(upgrades).toEqual(["host-1.example.org"]);
  });
});
