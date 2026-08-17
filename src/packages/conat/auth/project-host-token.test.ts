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
});
