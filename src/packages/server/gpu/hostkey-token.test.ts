/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import {
  formatHostkeyToken,
  hostkeyVerifier,
  newHostkeyToken,
  parseHostkeyAuthorization,
  parseHostkeyReport,
  parseHostkeyToken,
} from "./hostkey-token";

const BAY = "bay-1";

describe("host-key registration tokens", () => {
  it("makes a 256-bit token that parses back to itself", () => {
    const t = newHostkeyToken(BAY);
    expect(t.token).toMatch(
      /^ccr1\.bay-1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(Buffer.from(t.secret, "base64url")).toHaveLength(32);
    expect(parseHostkeyToken(t.token)).toEqual({
      authority_bay_id: BAY,
      token_id: t.token_id,
      secret: t.secret,
    });
    expect(formatHostkeyToken(parseHostkeyToken(t.token)!)).toBe(t.token);
    // a fresh secret every time
    expect(newHostkeyToken(BAY).secret).not.toBe(t.secret);
  });

  it("stores only a verifier over length-prefixed canonical fields", () => {
    const t = newHostkeyToken(BAY);
    expect(t.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(t.verifier).not.toContain(t.secret);
    // the documented construction, independently
    const h = createHash("sha256");
    for (const f of [
      "cocalc-gpu-hostkey",
      "v1",
      "pod-host-key",
      BAY,
      t.token_id,
      t.secret,
    ]) {
      const b = Buffer.from(f);
      const n = Buffer.alloc(4);
      n.writeUInt32BE(b.length);
      h.update(n).update(b);
    }
    expect(t.verifier).toBe(h.digest("hex"));
    // every field matters, including the authority bay
    const other = { ...t, authority_bay_id: "bay-2" };
    expect(hostkeyVerifier(other)).not.toBe(t.verifier);
    // fields can't run into each other
    expect(
      hostkeyVerifier({
        authority_bay_id: "ab",
        token_id: t.token_id,
        secret: t.secret,
      }),
    ).not.toBe(
      hostkeyVerifier({
        authority_bay_id: "a",
        token_id: t.token_id,
        secret: t.secret,
      }),
    );
  });

  it("refuses non-canonical and malformed tokens without throwing", () => {
    const t = newHostkeyToken(BAY);
    // the last base64url character carries 2 unused bits for 32 bytes
    const last = t.secret.slice(-1);
    const sibling = "AEIMQUYcgkosw048"
      .split("")
      .find(
        (c) =>
          c !== last &&
          Buffer.from(t.secret.slice(0, -1) + c, "base64url").equals(
            Buffer.from(t.secret, "base64url"),
          ),
      );
    const bad: unknown[] = [
      undefined,
      42,
      "",
      `ccr2.${BAY}.${t.token_id}.${t.secret}`,
      `ccr1.${BAY}.${t.token_id}`,
      `ccr1.${BAY}.${t.token_id}.${t.secret}.x`,
      `ccr1.BAY-1.${t.token_id}.${t.secret}`,
      `ccr1.${BAY}.${t.token_id.toUpperCase()}.${t.secret}`,
      // version 1, not version 4
      `ccr1.${BAY}.${t.token_id.slice(0, 14)}1${t.token_id.slice(15)}.${t.secret}`,
      `ccr1.${BAY}.${t.token_id}.${t.secret.slice(0, 42)}`,
      `ccr1.${BAY}.${t.token_id}.${t.secret}A`,
      `ccr1.${BAY}.${t.token_id}.${t.secret.slice(0, 42)}+`,
      `ccr1.${BAY}.${t.token_id}.${t.secret.slice(0, 42)}=`,
      "x".repeat(10_000),
    ];
    if (sibling) {
      bad.push(`ccr1.${BAY}.${t.token_id}.${t.secret.slice(0, -1)}${sibling}`);
    }
    for (const input of bad) {
      expect(parseHostkeyToken(input)).toBeUndefined();
    }
  });

  it("accepts exactly `Bearer <token>`", () => {
    const t = newHostkeyToken(BAY);
    expect(parseHostkeyAuthorization(`Bearer ${t.token}`)?.token_id).toBe(
      t.token_id,
    );
    for (const header of [
      undefined,
      t.token,
      `bearer ${t.token}`,
      `Bearer  ${t.token}`,
      `Bearer ${t.token} `,
      `Bearer ${t.token}, Bearer ${t.token}`,
      `Basic ${t.token}`,
    ]) {
      expect(parseHostkeyAuthorization(header)).toBeUndefined();
    }
  });

  it("accepts exactly {pod_id, host_public_key}", () => {
    const key = "ssh-ed25519 AAAA";
    expect(
      parseHostkeyReport({ pod_id: "pod_abc123", host_public_key: key }),
    ).toEqual({
      pod_id: "pod_abc123",
      host_public_key: key,
    });
    for (const body of [
      null,
      [],
      "x",
      { pod_id: "pod_abc123" },
      { pod_id: "pod_abc123", host_public_key: key, extra: 1 },
      { pod_id: "../etc", host_public_key: key },
      { pod_id: "pod_abc123", host_public_key: 7 },
      { pod_id: 123456, host_public_key: key },
    ]) {
      expect(parseHostkeyReport(body)).toBeUndefined();
    }
  });
});
