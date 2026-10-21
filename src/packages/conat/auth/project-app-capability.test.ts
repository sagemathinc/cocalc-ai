/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { generateKeyPairSync, sign } from "node:crypto";
import {
  isProjectAppKey,
  issueProjectAppCapability,
  parseProjectAppHostLabel,
  projectAppHostLabel,
  projectAppKey,
  projectAppRouteFromPath,
  PROJECT_APP_CAPABILITY_TTL_SECONDS,
  verifyProjectAppCapability,
} from "./project-app-capability";
import {
  issueProjectContentCapability,
  verifyProjectContentCapability,
} from "./project-content-capability";

const projectId = "00000000-0000-4000-8000-000000000004";
const otherProjectId = "00000000-0000-4000-8000-000000000005";
const hostId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const now_ms = 1_800_000_000_000;
const KEY = "p8888";

const issue = (extra: object = {}) =>
  issueProjectAppCapability({
    project_id: projectId,
    host_id: hostId,
    account_id: accountId,
    key: KEY,
    epoch: 2,
    private_key: privateKeyPem,
    now_ms,
    ...extra,
  });

const verify = (token: string, extra: object = {}) =>
  verifyProjectAppCapability({
    token,
    project_id: projectId,
    key: KEY,
    host_id: hostId,
    public_key: publicKeyPem,
    now_ms,
    ...extra,
  });

describe("app origin keys and hostnames", () => {
  it("one origin per port, server or app", () => {
    expect(projectAppKey({ kind: "port", port: 8888 })).toBe("p8888");
    const a = projectAppKey({ kind: "server", name: "jupyterlab" });
    const b = projectAppKey({ kind: "app", id: "jupyterlab" });
    expect(a).toMatch(/^s[0-9a-f]{10}$/);
    // A server and an app of the same name are different origins.
    expect(a).not.toBe(b);
    for (const port of [0, 65536, 1.5]) {
      expect(() => projectAppKey({ kind: "port", port })).toThrow();
    }
  });

  it("reads the route from the fixed path forms only", () => {
    const p = projectId;
    expect(projectAppRouteFromPath(p, `/${p}/port/8888/lab`)).toEqual({ kind: "port", port: 8888 });
    expect(projectAppRouteFromPath(p, `/${p}/proxy/3000/`)).toEqual({ kind: "port", port: 3000 });
    expect(projectAppRouteFromPath(p, `/${p}/server/code/x`)).toEqual({ kind: "server", name: "code" });
    expect(projectAppRouteFromPath(p, `/${p}/apps/my%20app/`)).toEqual({ kind: "app", id: "my app" });
    // A named server at /port/<name> is the same app as /server/<name>.
    expect(projectAppRouteFromPath(p, `/${p}/port/jupyterlab/lab`)).toEqual({ kind: "server", name: "jupyterlab" });
    for (const path of [
      `/${p}/port/0/`,
      `/${p}/port/99999/`,
      `/${p}/port/08/`,
      `/${p}/files/a.html`,
      `/${otherProjectId}/port/8888/`,
      `/${p}/port/`,
      `/${p}/apps/%E0%A4%A/`,
      `/${p}/port/9lives/`,
      `/${p}/proxy/a%2Fb/`,
    ]) {
      expect(projectAppRouteFromPath(p, path)).toBeUndefined();
    }
  });

  it("round-trips the hostname label, and refuses anything else", () => {
    const label = projectAppHostLabel({ project_id: projectId, key: KEY });
    expect(label).toBe("ap8888-00000000000040008000000000000004");
    expect(label.length).toBeLessThanOrEqual(63);
    expect(parseProjectAppHostLabel(label)).toEqual({ project_id: projectId, key: KEY });
    const s = projectAppKey({ kind: "server", name: "x" });
    expect(parseProjectAppHostLabel(projectAppHostLabel({ project_id: projectId, key: s }))).toEqual({ project_id: projectId, key: s });
    for (const bad of [
      "00000000000040008000000000000004", // a file hostname
      "ap0-00000000000040008000000000000004",
      "ap70000-00000000000040008000000000000004",
      "asXYZ-00000000000040008000000000000004",
      "ap8888-0000000000004000800000000000000",
      "Ap8888-00000000000040008000000000000004",
    ]) {
      expect(parseProjectAppHostLabel(bad)).toBeUndefined();
    }
    expect(isProjectAppKey("p65535")).toBe(true);
    expect(isProjectAppKey("p65536")).toBe(false);
  });
});

describe("app capabilities", () => {
  it("verify for exactly this app origin and host", () => {
    const { token, claims } = issue();
    expect(verify(token)).toEqual(claims);
    expect(claims.exp - claims.iat).toBe(PROJECT_APP_CAPABILITY_TTL_SECONDS);
    expect(() => verify(token, { key: "p8889" })).toThrow("different app");
    expect(() => verify(token, { project_id: otherProjectId })).toThrow("different app");
    expect(() =>
      verify(token, { host_id: "00000000-0000-4000-8000-000000000009" }),
    ).toThrow("different app");
  });

  it("expire after two minutes, and honour a restricted browser session", () => {
    const { token } = issue();
    expect(() => verify(token, { now_ms: now_ms + 121_000 })).toThrow("expired");
    const restricted = issue({ browser_session_exp_s: now_ms / 1000 + 60 }).token;
    expect(() => verify(restricted)).not.toThrow();
    expect(() => verify(restricted, { now_ms: now_ms + 61_000 })).toThrow("expired");
    expect(() =>
      issue({ browser_session_exp_s: now_ms / 1000 - 1 }),
    ).toThrow("browser session expired");
  });

  it("are never accepted as file capabilities, and vice versa", () => {
    const app = issue().token;
    expect(() =>
      verifyProjectContentCapability({
        token: app,
        project_id: projectId,
        host_id: hostId,
        public_key: publicKeyPem,
        now_ms,
      }),
    ).toThrow();
    const file = issueProjectContentCapability({
      project_id: projectId,
      host_id: hostId,
      account_id: accountId,
      epoch: 2,
      dir: "/",
      private_key: privateKeyPem,
      now_ms,
    }).token;
    expect(() => verify(file)).toThrow("invalid capability claims");
  });

  it("refuse tampering and a wrong key", () => {
    const { token } = issue();
    const [h, c] = token.split(".");
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, key: "p1" })).toString("base64url")}.${token.split(".")[2]}`;
    expect(() => verify(forged)).toThrow("signature");
    const other = generateKeyPairSync("ed25519");
    const signingInput = `${h}.${c}`;
    const badSig = sign(null, Buffer.from(signingInput), other.privateKey).toString("base64url");
    expect(() => verify(`${signingInput}.${badSig}`)).toThrow("signature");
  });
});
