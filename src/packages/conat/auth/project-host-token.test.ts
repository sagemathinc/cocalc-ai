/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { generateKeyPairSync } from "node:crypto";
import {
  issueProjectHostAuthToken,
  issueProjectHostApiKeyAuthToken,
  verifyProjectHostAuthToken,
} from "./project-host-token";
import { isProjectHostApiKeySubjectAllowed } from "./project-host-api-key-policy";

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

describe("project-host API key child tokens", () => {
  const projectId = "00000000-0000-4000-8000-000000000004";
  const nowMs = 1_000_000;
  const input = {
    host_id: hostId,
    account_id: accountId,
    project_id: projectId,
    key_id: "key-id-123",
    scope_revision: 3,
    placement_revision: 7,
    capabilities: ["file:read" as const],
    viewer_policy_hash: "a".repeat(64),
    private_key: privateKeyPem,
    now_ms: nowMs,
  };

  it("mints only reviewed runtime service subjects", () => {
    const issued = issueProjectHostApiKeyAuthToken({
      ...input,
      capabilities: ["project:exec"],
      viewer_policy_hash: undefined,
    });
    const binding = verifyProjectHostAuthToken({
      token: issued.token,
      host_id: hostId,
      public_key: publicKeyPem,
      now_ms: nowMs,
    }).api_key!;
    expect(binding.subjects).not.toContain(`project.${projectId}.`);
    for (const subject of [
      `project.${projectId}.run`,
      `project.${projectId}.api.-`,
      `project.${projectId}.project-info.-`,
      `terminal.project-${projectId}.session`,
      `persist.project-${projectId}.id`,
      `persist.project-${projectId}.server.shard.client`,
    ]) {
      expect(
        isProjectHostApiKeySubjectAllowed({ binding, subject, type: "pub" }),
      ).toBe(true);
    }
    for (const subject of [
      `project.${projectId}.future-control.-`,
      `project.${projectId}.api-management.-`,
      `hub.project.${projectId}.api`,
      `persist.project-${projectId}-foreign.id`,
      `persist.account-${accountId}.id`,
    ]) {
      expect(
        isProjectHostApiKeySubjectAllowed({ binding, subject, type: "pub" }),
      ).toBe(false);
    }
  });

  it("binds parent, placement, viewer policy, service audience and reply prefix", () => {
    const issued = issueProjectHostApiKeyAuthToken(input);
    const claims = verifyProjectHostAuthToken({
      token: issued.token,
      host_id: hostId,
      public_key: publicKeyPem,
      now_ms: nowMs,
    });
    expect(claims).toMatchObject({
      v: "phat-v3",
      sub: accountId,
      exp: 1025,
      api_key: {
        account_id: accountId,
        key_id: "key-id-123",
        scope_revision: 3,
        project_id: projectId,
        placement_revision: 7,
        capabilities: ["file:read"],
        viewer_policy_hash: "a".repeat(64),
        subjects: [
          `fs-api-key.project-${projectId}.account-${accountId}.key-key-id-123.rev-3.hash-${"a".repeat(64)}`,
        ],
        reply_prefix: `_INBOX.api-key-${claims.jti}`,
      },
    });
    expect(() =>
      verifyProjectHostAuthToken({
        token: issued.token,
        host_id: "00000000-0000-4000-8000-000000000005",
        public_key: publicKeyPem,
        now_ms: nowMs,
      }),
    ).toThrow("invalid token audience");
    expect(() =>
      verifyProjectHostAuthToken({
        token: issued.token,
        host_id: hostId,
        public_key: publicKeyPem,
        now_ms: issued.expires_at,
      }),
    ).toThrow("token expired");
  });

  it("never outlives the parent and rejects invalid viewer bindings", () => {
    const issued = issueProjectHostApiKeyAuthToken({
      ...input,
      parent_exp_s: 1004,
    });
    expect(issued.claims.exp).toBe(1004);
    expect(() =>
      issueProjectHostApiKeyAuthToken({
        ...input,
        parent_exp_s: 1000,
      }),
    ).toThrow("parent has expired");
    expect(() =>
      issueProjectHostApiKeyAuthToken({
        ...input,
        viewer_policy_hash: undefined,
      }),
    ).toThrow("viewer policy binding");
    expect(() =>
      issueProjectHostApiKeyAuthToken({
        ...input,
        placement_revision: -1,
      }),
    ).toThrow("project-host binding");
    expect(
      issueProjectHostApiKeyAuthToken({
        ...input,
        placement_revision: 0,
      }).claims.api_key.placement_revision,
    ).toBe(0);
  });

  it("rejects a modified child audience even with a valid parent identity", () => {
    const issued = issueProjectHostApiKeyAuthToken(input);
    const parts = issued.token.split(".");
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    claims.api_key.subjects.push(`fs.project-${projectId}`);
    parts[1] = Buffer.from(JSON.stringify(claims)).toString("base64url");
    expect(() =>
      verifyProjectHostAuthToken({
        token: parts.join("."),
        host_id: hostId,
        public_key: publicKeyPem,
        now_ms: nowMs,
      }),
    ).toThrow("invalid token signature");
  });
});
