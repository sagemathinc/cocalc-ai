/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { generateKeyPairSync, sign } from "node:crypto";
import {
  issueProjectContentCapability,
  PROJECT_CONTENT_CAPABILITY_TTL_SECONDS,
  verifyProjectContentCapability,
} from "./project-content-capability";
import {
  issueProjectHostAuthToken,
  verifyProjectHostAuthToken,
} from "./project-host-token";

const projectId = "00000000-0000-4000-8000-000000000004";
const otherProjectId = "00000000-0000-4000-8000-000000000005";
const hostId = "00000000-0000-4000-8000-000000000001";
const otherHostId = "00000000-0000-4000-8000-000000000006";
const accountId = "00000000-0000-4000-8000-000000000002";

function pems() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
const { privateKeyPem, publicKeyPem } = pems();
const now_ms = 1_800_000_000_000;

const issue = (extra = {}) =>
  issueProjectContentCapability({
    project_id: projectId,
    host_id: hostId,
    account_id: accountId,
    epoch: 3,
    dir: "/home/user/hw1",
    private_key: privateKeyPem,
    now_ms,
    ...extra,
  }).token;

const verify = (token: string, extra = {}) =>
  verifyProjectContentCapability({
    token,
    project_id: projectId,
    host_id: hostId,
    public_key: publicKeyPem,
    now_ms,
    ...extra,
  });

function b64url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Signs arbitrary claims with the real key, to check the verifier rejects
// well-signed tokens whose claims are wrong.
function signRaw(claims: object): string {
  const input = `${b64url(JSON.stringify({ typ: "JWT", alg: "EdDSA" }))}.${b64url(JSON.stringify(claims))}`;
  const sig = sign(null, Buffer.from(input), privateKeyPem);
  return `${input}.${b64url(sig)}`;
}

describe("project content capability", () => {
  it("verifies for its project, host, account and epoch", () => {
    const claims = verify(issue());
    expect(claims).toMatchObject({
      sub: accountId,
      aud: `project-content:${projectId}`,
      hid: hostId,
      epoch: 3,
      scope: "read",
      dir: "/home/user/hw1",
    });
  });

  it("carries a canonical directory, and refuses to issue for a relative or climbing one", () => {
    expect(verify(issue({ dir: "//home/user/hw1/" })).dir).toBe("/home/user/hw1");
    expect(verify(issue({ dir: "/" })).dir).toBe("/");
    for (const dir of ["home/user", "/home/../etc", "/home/./user", "", undefined]) {
      expect(() => issue({ dir })).toThrow("invalid content directory");
    }
  });

  it("is refused for another project or another host", () => {
    const token = issue();
    expect(() => verify(token, { project_id: otherProjectId })).toThrow(
      "different project or host",
    );
    expect(() => verify(token, { host_id: otherHostId })).toThrow(
      "different project or host",
    );
  });

  it("expires, and cannot be issued for more than a day", () => {
    const token = issue();
    expect(() =>
      verify(token, {
        now_ms: now_ms + PROJECT_CONTENT_CAPABILITY_TTL_SECONDS * 1000,
      }),
    ).toThrow("expired");
    expect(() =>
      issue({ ttl_seconds: PROJECT_CONTENT_CAPABILITY_TTL_SECONDS + 1 }),
    ).toThrow("lifetime");
  });

  it("rejects another key's signature and edited claims", () => {
    const other = pems();
    expect(() => verify(issue({ private_key: other.privateKeyPem }))).toThrow(
      "signature",
    );
    const [h, c, s] = issue().split(".");
    const edited = JSON.parse(Buffer.from(c, "base64url").toString());
    edited.epoch = 4;
    expect(() => verify(`${h}.${b64url(JSON.stringify(edited))}.${s}`)).toThrow(
      "signature",
    );
  });

  it("rejects well-signed tokens with extra, missing or wrong claims", () => {
    const good = JSON.parse(Buffer.from(issue().split(".")[1], "base64url").toString());
    expect(verify(signRaw(good)).sub).toBe(accountId);
    expect(() => verify(signRaw({ ...good, act: "hub" }))).toThrow("claims");
    const { epoch: _epoch, ...missing } = good;
    expect(() => verify(signRaw(missing))).toThrow("claims");
    expect(() => verify(signRaw({ ...good, scope: "write" }))).toThrow("claims");
    expect(() => verify(signRaw({ ...good, v: "phat-v1" }))).toThrow("claims");
    expect(() => verify(signRaw({ ...good, v: "pcc-v1" }))).toThrow("claims");
    const { dir: _dir, ...noDir } = good;
    expect(() => verify(signRaw(noDir))).toThrow("claims");
    for (const dir of ["/home/user/hw1/", "home/user", "/home/user/../x", 7]) {
      expect(() => verify(signRaw({ ...good, dir }))).toThrow("claims");
    }
    expect(() =>
      verify(signRaw({ ...good, exp: good.iat + PROJECT_CONTENT_CAPABILITY_TTL_SECONDS + 1 })),
    ).toThrow("expired");
  });

  it("is never interchangeable with a project-host auth token", () => {
    const hostToken = issueProjectHostAuthToken({
      host_id: hostId,
      account_id: accountId,
      private_key: privateKeyPem,
      now_ms,
    }).token;
    expect(() => verify(hostToken)).toThrow("claims");
    expect(() =>
      verifyProjectHostAuthToken({
        token: issue(),
        host_id: hostId,
        public_key: publicKeyPem,
        now_ms,
      }),
    ).toThrow();
  });
});
