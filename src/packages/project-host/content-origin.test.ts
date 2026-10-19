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
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalPathWithinDir,
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
    dir: "/",
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
let realPathWithinDir: (opts: { project_id: string; path: string; dir: string }) => Promise<boolean>;
let realChecks: { project_id: string; path: string; dir: string }[];

beforeEach(async () => {
  served = [];
  passedOn = [];
  errors = [];
  epoch = 0;
  realChecks = [];
  realPathWithinDir = async () => true;
  const handler = createContentOriginHandler({
    domain,
    host_id: hostId,
    getPublicKey: () => publicKeyPem,
    frameAncestors: () => ["https://app.example.org"],
    hasReadAccess: ({ account_id, project_id }) =>
      account_id === member && (project_id === projectA || project_id === projectB),
    currentEpoch: () => epoch,
    realPathWithinDir: async (opts) => {
      realChecks.push(opts);
      return await realPathWithinDir(opts);
    },
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

  it("serves only inside the capability's folder", async () => {
    const c = cap({ dir: "/home/user/cs101-collect/hw1/student-1" });
    const inside = await get(
      hostA,
      `/_c/${c}/files/home/user/cs101-collect/hw1/student-1/img/a%20b.png`,
    );
    expect(inside.status).toBe(200);
    expect(realChecks).toEqual([
      {
        project_id: projectA,
        path: "/home/user/cs101-collect/hw1/student-1/img/a b.png",
        dir: "/home/user/cs101-collect/hw1/student-1",
      },
    ]);
    for (const path of [
      "home/user/cs101.course",
      "home/user/hw1/solution.ipynb",
      "home/user/cs101-collect/hw1/student-2/page.html",
      "home/user/cs101-collect/hw1/student-10/page.html",
      "home/user/cs101-collect/hw1/student-1",
    ]) {
      const r = await get(hostA, `/_c/${c}/files/${path}`);
      expect(r.status).toBe(path.endsWith("student-1") ? 200 : 403);
    }
    expect(served.map((x) => x.url)).toEqual([
      `/${projectA}/files/home/user/cs101-collect/hw1/student-1/img/a%20b.png`,
      `/${projectA}/files/home/user/cs101-collect/hw1/student-1`,
    ]);
  });

  it("refuses a path whose real location leaves the folder, and fails closed if that can't be checked", async () => {
    const c = cap({ dir: "/home/user/sub" });
    realPathWithinDir = async () => false;
    expect((await get(hostA, `/_c/${c}/files/home/user/sub/link.txt`)).status).toBe(403);
    realPathWithinDir = async () => {
      throw new Error("ELOOP");
    };
    expect((await get(hostA, `/_c/${c}/files/home/user/sub/loop.txt`)).status).toBe(404);
    expect(served).toEqual([]);
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

  it("claims content-shaped hostnames under any domain, and fails closed", async () => {
    const shaped = projectContentHostname({
      project_id: projectA,
      host_id: hostId,
      domain: "other.example.net",
    });
    expect((await get(shaped, `/_c/${cap()}/files/page.html`)).status).toBe(404);
    expect((await get(shaped, "/healthz")).status).toBe(404);
    expect(passedOn).toEqual([]);
    expect(served).toEqual([]);
  });

  it("refuses encoded slashes and backslashes inside a segment", async () => {
    const c = cap();
    expect((await get(hostA, `/_c/${c}/files/a/..%2Fb.html`)).status).toBe(404);
    expect((await get(hostA, `/_c/${c}/files/a%5C..%5Cb.html`)).status).toBe(404);
    expect(served).toEqual([]);
  });

  it("drops Set-Cookie passed to writeHead in any form", async () => {
    for (const headers of [
      ["Set-Cookie", "a=1", "Content-Type", "text/plain"],
      { "Set-Cookie": "a=1", "Content-Type": "text/plain" },
    ]) {
      const handler = createContentOriginHandler({
        domain,
        host_id: hostId,
        getPublicKey: () => publicKeyPem,
        frameAncestors: () => [],
        hasReadAccess: () => true,
        currentEpoch: () => 0,
        realPathWithinDir: async () => true,
        serveFile: async ({ res }) => {
          res.writeHead(200, headers as any);
          res.end("ok");
        },
      });
      const s = createServer((req, res) => void handler(req, res, () => res.end()));
      await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
      const r = await new Promise<{ status: number; cookie: unknown; type: unknown }>(
        (resolve, reject) => {
          request(
            {
              host: "127.0.0.1",
              port: (s.address() as AddressInfo).port,
              path: `/_c/${cap()}/files/a.txt`,
              headers: { host: hostA },
            },
            (res) => {
              res.resume();
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  cookie: res.headers["set-cookie"],
                  type: res.headers["content-type"],
                }),
              );
            },
          )
            .on("error", reject)
            .end();
        },
      );
      await new Promise<void>((resolve) => s.close(() => resolve()));
      expect(r).toEqual({ status: 200, cookie: undefined, type: "text/plain" });
    }
  });

  it("removes the capability from req.url and req.originalUrl at once", async () => {
    const c = cap();
    const seen: string[] = [];
    const handler = createContentOriginHandler({
      domain,
      host_id: hostId,
      getPublicKey: () => publicKeyPem,
      frameAncestors: () => [],
      hasReadAccess: () => true,
      currentEpoch: () => 1, // stale: refused before serving
      realPathWithinDir: async () => true,
      serveFile: async () => {},
    });
    const req: any = {
      headers: { host: hostA },
      method: "GET",
      url: `/_c/${c}/files/a.html`,
      originalUrl: `/_c/${c}/files/a.html`,
    };
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, unknown>,
      setHeader(name: string, value: unknown) {
        this.headers[name.toLowerCase()] = value;
      },
      hasHeader: () => false,
      removeHeader: () => {},
      writeHead() {},
      end() {
        seen.push(`${req.url} ${req.originalUrl}`);
      },
    };
    await handler(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(seen).toEqual(["/ /"]);
    expect(JSON.stringify(req)).not.toContain(c);
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

describe("canonicalPathWithinDir on a real sandboxed filesystem", () => {
  let tmp: string;
  let fs: SandboxedFilesystem;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "content-origin-"));
    const home = join(tmp, "home");
    await mkdir(join(home, "collect", "student-1", "img"), { recursive: true });
    await writeFile(join(home, "grades.course"), "benign");
    await writeFile(join(home, "collect", "student-1", "page.html"), "<p>benign</p>");
    await writeFile(join(home, "collect", "student-1", "img", "a.png"), "png");
    // What a collected folder could carry: links pointing out of it.
    await symlink("../../grades.course", join(home, "collect", "student-1", "grades-link"));
    await symlink("..", join(home, "collect", "student-1", "up"));
    await symlink("img", join(home, "collect", "student-1", "pictures"));
    fs = new SandboxedFilesystem(home, { homeAliases: ["/home/user"] });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const within = (path: string) =>
    canonicalPathWithinDir({ fs, path, dir: "/home/user/collect/student-1" });

  it("allows files and links that stay inside the folder", async () => {
    expect(await within("/home/user/collect/student-1/page.html")).toBe(true);
    expect(await within("/home/user/collect/student-1/img/a.png")).toBe(true);
    expect(await within("/home/user/collect/student-1/pictures/a.png")).toBe(true);
    expect(await within("/home/user/collect/student-1/missing.css")).toBe(true);
  });

  it("refuses links that lead out of the folder", async () => {
    expect(await within("/home/user/collect/student-1/grades-link")).toBe(false);
    expect(await within("/home/user/collect/student-1/up/student-1/page.html")).toBe(true);
    expect(await within("/home/user/collect/student-1/up/other.html")).toBe(false);
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
