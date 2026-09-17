/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { generateKeyPairSync } from "node:crypto";
import {
  issueProjectHostAuthToken,
  verifyProjectHostAuthToken,
} from "./project-host-token";

const hostId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey
  .export({
    type: "pkcs8",
    format: "pem",
  })
  .toString();
const publicKeyPem = publicKey
  .export({
    type: "spki",
    format: "pem",
  })
  .toString();

describe("project-host agent session tokens", () => {
  it.each(["account", "agent"] as const)(
    "signs credential provenance %s and rejects tampering",
    (auth_actor) => {
      const issued = issueProjectHostAuthToken({
        host_id: hostId,
        account_id: accountId,
        private_key: privateKeyPem,
        auth_actor,
      });
      const verify = (token: string) =>
        verifyProjectHostAuthToken({
          token,
          host_id: hostId,
          public_key: publicKeyPem,
        });
      expect(verify(issued.token).auth_actor).toBe(auth_actor);
      const parts = issued.token.split(".");
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      claims.auth_actor = auth_actor === "agent" ? "account" : "agent";
      parts[1] = Buffer.from(JSON.stringify(claims)).toString("base64url");
      expect(() => verify(parts.join("."))).toThrow("invalid token signature");
    },
  );
  it("signs and verifies the stable session id", () => {
    const issued = issueProjectHostAuthToken({
      host_id: hostId,
      account_id: accountId,
      private_key: privateKeyPem,
      session_id: sessionId,
      now_ms: 1_000_000,
    });
    const claims = verifyProjectHostAuthToken({
      token: issued.token,
      host_id: hostId,
      public_key: publicKeyPem,
      now_ms: 1_000_000,
    });
    expect(claims.sid).toBe(sessionId);
  });

  it("rejects malformed session ids before signing", () => {
    expect(() =>
      issueProjectHostAuthToken({
        host_id: hostId,
        account_id: accountId,
        private_key: privateKeyPem,
        session_id: "not-a-session",
      }),
    ).toThrow("invalid session_id");
  });

  it("signs a restricted browser-session expiration with a new token version", () => {
    const nowMs = 1_000_000;
    const browserSessionExp = Math.floor(nowMs / 1000) + 3600;
    const issued = issueProjectHostAuthToken({
      host_id: hostId,
      account_id: accountId,
      private_key: privateKeyPem,
      browser_session_exp_s: browserSessionExp,
      now_ms: nowMs,
    });

    expect(
      verifyProjectHostAuthToken({
        token: issued.token,
        host_id: hostId,
        public_key: publicKeyPem,
        now_ms: nowMs,
      }),
    ).toMatchObject({
      v: "phat-v2",
      browser_session_exp_s: browserSessionExp,
    });
  });

  it("rejects invalid restricted browser-session expirations", () => {
    expect(() =>
      issueProjectHostAuthToken({
        host_id: hostId,
        account_id: accountId,
        private_key: privateKeyPem,
        browser_session_exp_s: 1000,
        now_ms: 1_000_000,
      }),
    ).toThrow("invalid browser session expiration");
  });
});
