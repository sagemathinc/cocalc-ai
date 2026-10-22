/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { generateKeyPairSync } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  issueProjectAppCapability,
  projectAppKey,
} from "@cocalc/conat/auth/project-app-capability";
import {
  APP_SESSION_COOKIE,
  appRequestRejection,
  createAppOriginHandler,
  createAppSessionToken,
  looksLikeAppHostname,
  parseAppHostname,
  rewriteUpstreamResponseCookies,
  rewriteUpstreamSetCookie,
  verifyAppSessionToken,
  withoutAppSessionCookie,
} from "./content-app-origin";
import { looksLikeContentHostname } from "./content-origin";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }) as string;

const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const HOST = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const DOMAIN = "usercontent.example";
const SITE = "https://cocalc.example";
const P32 = PROJECT.replace(/-/g, "");
const H32 = HOST.replace(/-/g, "");
const APP_HOST = `ap8000-${P32}.h-${H32}.${DOMAIN}`;
const SECRET = "host-secret";

describe("hostnames", () => {
  it("parses only app hostnames of this host", () => {
    expect(parseAppHostname(APP_HOST, { domain: DOMAIN, host_id: HOST })).toEqual({
      project_id: PROJECT,
      key: "p8000",
      hostname: APP_HOST,
    });
    expect(
      parseAppHostname(`${APP_HOST.toUpperCase()}:443`, { domain: DOMAIN, host_id: HOST }),
    ).toMatchObject({ key: "p8000" });
    for (const host of [
      `${P32}.h-${H32}.${DOMAIN}`,
      `ap8000-${P32}.h-${"5".repeat(32)}.${DOMAIN}`,
      `ap8000-${P32}.h-${H32}.other.example`,
      `ap0-${P32}.h-${H32}.${DOMAIN}`,
      `ap70000-${P32}.h-${H32}.${DOMAIN}`,
      `x.ap8000-${P32}.h-${H32}.${DOMAIN}`,
    ]) {
      expect(parseAppHostname(host, { domain: DOMAIN, host_id: HOST })).toBeUndefined();
    }
  });

  it("app hostnames have the content shape under any domain (fail closed)", () => {
    expect(looksLikeAppHostname(APP_HOST)).toBe(true);
    expect(looksLikeContentHostname(APP_HOST)).toBe(true);
    expect(looksLikeContentHostname(`as0123456789-${P32}.h-${H32}.any.where`)).toBe(true);
    expect(looksLikeContentHostname(`${P32}.h-${H32}.any.where`)).toBe(true);
    expect(looksLikeAppHostname(`${P32}.h-${H32}.any.where`)).toBe(false);
    expect(looksLikeContentHostname("lite4b.cocalc.ai")).toBe(false);
  });
});

describe("sessions", () => {
  const session = {
    account_id: ACCOUNT,
    project_id: PROJECT,
    key: "p8000",
    host_id: HOST,
    epoch: 2,
    auth_iat_s: 1000,
    exp_s: 2_000_000_000,
  };
  const target = { secret: SECRET, project_id: PROJECT, key: "p8000", host_id: HOST };

  it("round-trips for exactly its app", () => {
    const token = createAppSessionToken(session, { secret: SECRET });
    expect(verifyAppSessionToken(token, target)).toEqual(session);
    expect(verifyAppSessionToken(token, { ...target, key: "p8001" })).toBeUndefined();
    expect(verifyAppSessionToken(token, { ...target, project_id: OTHER_PROJECT })).toBeUndefined();
    expect(verifyAppSessionToken(token, { ...target, secret: "other" })).toBeUndefined();
    expect(
      verifyAppSessionToken(token, { ...target, now_ms: 2_000_000_000 * 1000 }),
    ).toBeUndefined();
  });

  it("rejects tampering", () => {
    const token = createAppSessionToken(session, { secret: SECRET });
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        exp: 2_100_000_000,
      }),
    ).toString("base64url");
    expect(verifyAppSessionToken(`${forged}.${mac}`, target)).toBeUndefined();
    expect(verifyAppSessionToken(`${token}.x`, target)).toBeUndefined();
  });
});

describe("request policy", () => {
  const origin = `https://${APP_HOST}`;
  const req = (headers: Record<string, string>, method = "GET") => ({ headers, method });

  it("allows same-origin requests and top-level navigations", () => {
    expect(appRequestRejection(req({ "sec-fetch-site": "same-origin" }, "POST"))).toBeUndefined();
    expect(
      appRequestRejection(
        req({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }),
        { origin },
      ),
    ).toBeUndefined();
    expect(
      appRequestRejection(
        req({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }),
        { origin },
      ),
    ).toBeUndefined();
  });

  it("refuses other apps' subresources, frames and posts", () => {
    for (const headers of [
      { "sec-fetch-site": "same-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
      { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
      { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
    ]) {
      expect(appRequestRejection(req(headers))).toBeDefined();
    }
    expect(
      appRequestRejection(
        req({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, "POST"),
        { origin },
      ),
    ).toBeDefined();
    // Without fetch metadata (sessions only go to browsers that send it).
    expect(appRequestRejection(req({ origin }, "POST"))).toBeDefined();
    expect(appRequestRejection(req({}))).toBeDefined();
  });
});

describe("cookies", () => {
  it("hides the app session from the user's server", () => {
    expect(withoutAppSessionCookie(`a=1; ${APP_SESSION_COOKIE}=x; b=2`)).toBe("a=1; b=2");
    expect(withoutAppSessionCookie(`${APP_SESSION_COOKIE}=x`)).toBeUndefined();
  });

  it("makes the server's cookies host-only and never lets it set the session", () => {
    expect(rewriteUpstreamSetCookie("a=1; Domain=.usercontent.example; Path=/")).toBe("a=1; Path=/");
    expect(rewriteUpstreamSetCookie("a=1;domain=x")).toBe("a=1");
    expect(rewriteUpstreamSetCookie(`${APP_SESSION_COOKIE}=forged; Path=/`)).toBeUndefined();
  });

  it("rewrites upstream response headers in place (HTTP and websocket 101s)", () => {
    const headers: any = { "set-cookie": ["a=1; Domain=x.example", `${APP_SESSION_COOKIE}=f`] };
    rewriteUpstreamResponseCookies(headers);
    expect(headers["set-cookie"]).toEqual(["a=1"]);
    const only: any = { "set-cookie": `${APP_SESSION_COOKIE}=f` };
    rewriteUpstreamResponseCookies(only);
    expect("set-cookie" in only).toBe(false);
  });
});

describe("app origin handler", () => {
  let server: Server;
  let port: number;
  let epoch: number;
  let collaborator: boolean;
  let cutoff: number | undefined;
  const used = new Set<string>();
  const proxy = jest.fn();
  const matchApp = jest.fn();
  const NOW = Date.UTC(2026, 9, 21, 12);

  beforeEach(async () => {
    epoch = 0;
    collaborator = true;
    cutoff = undefined;
    used.clear();
    proxy.mockReset();
    proxy.mockImplementation(async (req, res, auth) => {
      res.setHeader("Set-Cookie", ["s=1; Domain=usercontent.example", `${APP_SESSION_COOKIE}=x`]);
      res.setHeader("Content-Security-Policy", "default-src 'self'");
      res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null, ...auth }));
    });
    matchApp.mockReset();
    matchApp.mockResolvedValue(undefined);
    const origin = createAppOriginHandler({
      domain: DOMAIN,
      host_id: HOST,
      getPublicKey: () => PUBLIC_KEY,
      getSecret: () => SECRET,
      approvedOrigins: () => new Set([SITE]),
      siteOrigin: () => SITE,
      isCollaborator: () => collaborator,
      currentEpoch: () => epoch,
      accountRevokedBeforeMs: () => cutoff,
      consumeCapability: ({ jti }) => {
        if (used.has(jti)) return false;
        used.add(jti);
        return true;
      },
      matchApp,
      proxy,
      now: () => NOW,
    });
    server = createServer((req, res) => {
      void origin.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const send = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
  ): Promise<{ status: number; headers: Record<string, any>; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method, headers: { host: APP_HOST, ...headers } },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });

  const navigation = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    referer: `${SITE}/`,
  };

  const capability = (opts: Partial<Parameters<typeof issueProjectAppCapability>[0]> = {}) =>
    issueProjectAppCapability({
      project_id: PROJECT,
      host_id: HOST,
      account_id: ACCOUNT,
      key: "p8000",
      epoch: 0,
      private_key: PRIVATE_KEY,
      now_ms: NOW,
      ...opts,
    }).token;

  const next = encodeURIComponent(`/${PROJECT}/port/8000/a/?x=1`);

  async function signIn(): Promise<string> {
    const res = await send(`/_a/${capability()}?next=${next}`, navigation);
    expect(res.status).toBe(302);
    const cookie = `${res.headers["set-cookie"]?.[0] ?? ""}`;
    return cookie.split(";")[0];
  }

  it("redeems a capability once for a session on this origin", async () => {
    const token = capability();
    const res = await send(`/_a/${token}?next=${next}`, navigation);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`https://${APP_HOST}/${PROJECT}/port/8000/a/?x=1`);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    const cookie = `${res.headers["set-cookie"]?.[0]}`;
    expect(cookie).toMatch(new RegExp(`^${APP_SESSION_COOKIE}=[^;]+; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200$`));
    // Single use.
    const again = await send(`/_a/${token}?next=${next}`, navigation);
    expect(again.status).toBe(403);
  });

  it("bootstraps only from the site, as a top-level navigation", async () => {
    for (const headers of [
      { ...navigation, referer: "https://evil.example/" },
      { ...navigation, referer: "" },
      { ...navigation, "sec-fetch-dest": "iframe" },
      { ...navigation, "sec-fetch-mode": "cors" },
      { ...navigation, "sec-fetch-site": "same-site" },
    ]) {
      const res = await send(`/_a/${capability()}?next=${next}`, headers);
      expect(res.status).toBe(403);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    expect(used.size).toBe(0);
  });

  it("refuses capabilities of another app, older epochs, revoked accounts and ex-members", async () => {
    let res = await send(`/_a/${capability({ key: "p8001" })}?next=${next}`, navigation);
    expect(res.status).toBe(403);
    epoch = 1;
    res = await send(`/_a/${capability()}?next=${next}`, navigation);
    expect(res.status).toBe(403);
    epoch = 0;
    cutoff = NOW;
    res = await send(`/_a/${capability()}?next=${next}`, navigation);
    expect(res.status).toBe(403);
    cutoff = undefined;
    collaborator = false;
    res = await send(`/_a/${capability()}?next=${next}`, navigation);
    expect(res.status).toBe(403);
  });

  it("only goes to a path of this app", async () => {
    for (const path of [
      `/${PROJECT}/port/8001/`,
      `/${PROJECT}/files/a.html`,
      `/${OTHER_PROJECT}/port/8000/`,
      `//evil.example/`,
      `/${PROJECT}/port/8000/../../x`,
      `https://evil.example/`,
    ]) {
      const res = await send(`/_a/${capability()}?next=${encodeURIComponent(path)}`, navigation);
      expect([400, 404]).toContain(res.status);
      expect(res.headers.location).toBeUndefined();
    }
  });

  it("bounds the session by a restricted hub session", async () => {
    const token = capability({ browser_session_exp_s: NOW / 1000 + 600 });
    const res = await send(`/_a/${token}?next=${next}`, navigation);
    expect(`${res.headers["set-cookie"]?.[0]}`).toContain("Max-Age=600");
  });

  it("proxies requests with the session, without it or any host auth", async () => {
    const cookie = await signIn();
    const res = await send(`/${PROJECT}/port/8000/a/?x=1`, {
      cookie: `mine=1; ${cookie}`,
      authorization: "Bearer for-the-app",
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      url: `/${PROJECT}/port/8000/a/?x=1`,
      cookie: "mine=1",
      auth: "Bearer for-the-app",
      account_id: ACCOUNT,
      issued_at_s: NOW / 1000,
      exp_s: NOW / 1000 + 12 * 3600,
      project_id: PROJECT,
      epoch: 0,
    });
    expect(res.headers["set-cookie"]).toEqual(["s=1"]);
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'self', default-src 'self'");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
    // /proxy/8000 is the same app.
    expect((await send(`/${PROJECT}/proxy/8000/`, { cookie, "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("serves only this app's paths", async () => {
    const cookie = await signIn();
    for (const path of [
      `/${PROJECT}/port/8001/`,
      `/${PROJECT}/files/a.html`,
      `/${PROJECT}/upload`,
      `/${OTHER_PROJECT}/port/8000/`,
      `/conat/`,
      `/`,
      `/${PROJECT}/server/x/`,
    ]) {
      const res = await send(path, { cookie, "sec-fetch-site": "same-origin" });
      expect(res.status).toBe(404);
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it("an app at its own base path serves only that prefix", async () => {
    const key = projectAppKey({ kind: "app", id: "myapp" });
    matchApp.mockImplementation(async ({ url }) =>
      url.startsWith(`/${PROJECT}/myapp/`)
        ? { spec: { id: "myapp", proxy: { base_path: "/myapp" } } }
        : url.startsWith(`/${PROJECT}/`)
          ? { spec: { id: "root", proxy: { base_path: "/" } } }
          : undefined,
    );
    const host = `a${key}-${P32}.h-${H32}.${DOMAIN}`;
    const token = issueProjectAppCapability({
      project_id: PROJECT,
      host_id: HOST,
      account_id: ACCOUNT,
      key,
      epoch: 0,
      private_key: PRIVATE_KEY,
      now_ms: NOW,
    }).token;
    let res = await send(
      `/_a/${token}?next=${encodeURIComponent(`/${PROJECT}/myapp/`)}`,
      { ...navigation, host },
    );
    expect(res.status).toBe(302);
    const cookie = `${res.headers["set-cookie"]?.[0]}`.split(";")[0];
    res = await send(`/${PROJECT}/myapp/x`, { host, cookie, "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    res = await send(`/${PROJECT}/other/x`, { host, cookie, "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(404);
  });

  it("refuses service workers", async () => {
    const cookie = await signIn();
    const res = await send(`/${PROJECT}/port/8000/sw.js`, {
      cookie,
      "service-worker": "script",
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(403);
  });

  it("refuses requests from other sites and apps", async () => {
    const cookie = await signIn();
    let res = await send(`/${PROJECT}/port/8000/`, {
      cookie,
      "sec-fetch-site": "same-site",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    }, "POST");
    expect(res.status).toBe(403);
    res = await send(`/${PROJECT}/port/8000/`, {
      cookie,
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
    });
    expect(res.status).toBe(403);
    expect(proxy).not.toHaveBeenCalled();
  });

  it("re-opens through the site when there is no session; other requests get 401", async () => {
    let res = await send(`/${PROJECT}/port/8000/a?b=1`, navigation);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${SITE}/app-open/${PROJECT}/port/8000/a?b=1`);
    res = await send(`/${PROJECT}/port/8000/a`, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(401);
  });

  it("ends sessions on revocation, a new epoch or loss of membership", async () => {
    const cookie = await signIn();
    const ok = { cookie, "sec-fetch-site": "same-origin" };
    expect((await send(`/${PROJECT}/port/8000/`, ok)).status).toBe(200);
    cutoff = NOW;
    expect((await send(`/${PROJECT}/port/8000/`, ok)).status).toBe(401);
    cutoff = undefined;
    collaborator = false;
    expect((await send(`/${PROJECT}/port/8000/`, ok)).status).toBe(401);
    collaborator = true;
    epoch = 1;
    expect((await send(`/${PROJECT}/port/8000/`, ok)).status).toBe(401);
    // A new bootstrap clears what the revoked session left.
    const res = await send(`/_a/${capability({ epoch: 1 })}?next=${next}`, { ...navigation, cookie });
    expect(res.status).toBe(302);
    expect(res.headers["clear-site-data"]).toBe('"storage", "cache"');
  });

  it("a session of one app is no session for another", async () => {
    const cookie = await signIn();
    const res = await send(`/${PROJECT}/port/8001/`, {
      host: `ap8001-${P32}.h-${H32}.${DOMAIN}`,
      cookie,
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(401);
  });
});

describe("app origin websockets", () => {
  const NOW = Date.UTC(2026, 9, 21, 12);
  let collaborator = true;
  const origin = createAppOriginHandler({
    domain: DOMAIN,
    host_id: HOST,
    getPublicKey: () => PUBLIC_KEY,
    getSecret: () => SECRET,
    approvedOrigins: () => new Set([SITE]),
    siteOrigin: () => SITE,
    isCollaborator: () => collaborator,
    currentEpoch: () => 0,
    accountRevokedBeforeMs: () => undefined,
    consumeCapability: () => true,
    matchApp: async () => undefined,
    proxy: async () => {},
    now: () => NOW,
  });
  const cookie = `${APP_SESSION_COOKIE}=${createAppSessionToken(
    {
      account_id: ACCOUNT,
      project_id: PROJECT,
      key: "p8000",
      host_id: HOST,
      epoch: 0,
      auth_iat_s: NOW / 1000,
      exp_s: NOW / 1000 + 60,
    },
    { secret: SECRET },
  )}`;
  const upgrade = (headers: Record<string, string>, url = `/${PROJECT}/port/8000/ws`) =>
    ({ url, headers: { host: APP_HOST, origin: `https://${APP_HOST}`, cookie: `x=1; ${cookie}`, ...headers } }) as any;

  it("authorizes the app's own websockets, without the session cookie", async () => {
    const req = upgrade({});
    expect(await origin.authorizeUpgrade(req)).toEqual({
      account_id: ACCOUNT,
      issued_at_s: NOW / 1000,
      exp_s: NOW / 1000 + 60,
      project_id: PROJECT,
      epoch: 0,
    });
    expect(req.headers.cookie).toBe("x=1");
  });

  it("refuses other origins, other apps' paths and missing sessions", async () => {
    expect(await origin.authorizeUpgrade(upgrade({ origin: "https://evil.example" }))).toBeUndefined();
    expect(
      await origin.authorizeUpgrade(upgrade({ origin: `https://ap8001-${P32}.h-${H32}.${DOMAIN}` })),
    ).toBeUndefined();
    expect(await origin.authorizeUpgrade(upgrade({}, `/${PROJECT}/port/8001/ws`))).toBeUndefined();
    expect(await origin.authorizeUpgrade(upgrade({}, `/conat/`))).toBeUndefined();
    expect(await origin.authorizeUpgrade(upgrade({ cookie: "x=1" }))).toBeUndefined();
    collaborator = false;
    expect(await origin.authorizeUpgrade(upgrade({}))).toBeUndefined();
    collaborator = true;
  });
});
