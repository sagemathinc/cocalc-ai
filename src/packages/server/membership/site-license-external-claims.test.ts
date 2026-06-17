/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import dayjs from "dayjs";
import { generateKeyPairSync, sign as signData } from "crypto";

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import {
  createTestAccount,
  createTestMembershipTier,
} from "@cocalc/server/purchases/test-data";
import { uuid } from "@cocalc/util/misc";

import { resolveMembershipForAccount } from "./resolve";
import { adminProvisionSiteLicense } from "./site-licenses";
import {
  addSiteLicenseExternalClaimKey,
  consumeSiteLicenseExternalClaimToken,
  consumeVerifiedSiteLicenseExternalClaim,
  createSiteLicenseExternalClaimPool,
  hashSiteLicenseExternalClaimToken,
} from "./site-license-external-claims";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("site license external claim tokens", () => {
  const defaultTier = `external-default-${uuid()}`;
  const overrideTier = `external-override-${uuid()}`;

  beforeAll(async () => {
    await createTestMembershipTier({
      id: defaultTier,
      priority: 10,
      price_yearly: 100,
    });
    await createTestMembershipTier({
      id: overrideTier,
      priority: 20,
      price_yearly: 200,
    });
  });

  async function provisionExternalClaimPool({
    seat_count = 5,
    allow_membership_class_override = false,
    allow_membership_expires_at_override = false,
    default_membership_duration_days,
    max_membership_duration_days,
  }: {
    seat_count?: number;
    allow_membership_class_override?: boolean;
    allow_membership_expires_at_override?: boolean;
    default_membership_duration_days?: number;
    max_membership_duration_days?: number;
  } = {}) {
    const admin_account_id = uuid();
    const owner_account_id = uuid();
    await createTestAccount(admin_account_id);
    await createTestAccount(owner_account_id);
    const overview = await adminProvisionSiteLicense({
      actor_account_id: admin_account_id,
      owner_account_id,
      name: `External Claims ${uuid()}`,
      organization_name: "External Claims Test",
      allowed_domains: [`${uuid()}.example.edu`],
      pools: [
        {
          pool_name: "External claim seats",
          membership_class: defaultTier,
          seat_count,
          requires_approval: false,
          verification_policy: "email-domain",
          allowed_domains: [`${uuid()}.example.edu`],
        },
      ],
      trusted_admin: true,
    });
    const package_id = overview.pools[0]!.id;
    const claimPool = await createSiteLicenseExternalClaimPool({
      slug: `cup-${uuid().slice(0, 8)}`,
      site_license_id: overview.site_license.id,
      package_id,
      name: "CUP external claims",
      issuer: "cambridge-university-press",
      default_membership_class: defaultTier,
      allow_membership_class_override,
      allow_membership_expires_at_override,
      default_membership_duration_days,
      max_membership_duration_days,
      default_rootfs_id: "cocalc.local/rootfs/test",
      max_claims: seat_count,
      max_claims_per_account: 1,
      created_by_account_id: admin_account_id,
    });
    return { overview, claimPool };
  }

  function compactEdDsaToken({
    privateKey,
    kid,
    payload,
  }: {
    privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
    kid: string;
    payload: Record<string, unknown>;
  }): string {
    const encodedHeader = Buffer.from(
      JSON.stringify({ alg: "EdDSA", kid, typ: "JWT" }),
    ).toString("base64url");
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = signData(null, Buffer.from(signingInput), privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  }

  async function addEdDsaKey(pool_id: string) {
    const kid = `kid-${uuid()}`;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await addSiteLicenseExternalClaimKey({
      pool_id,
      kid,
      alg: "EdDSA",
      public_key_jwk: publicKey.export({ format: "jwk" }) as Record<
        string,
        unknown
      >,
    });
    return { kid, privateKey };
  }

  it("consumes a verified claim once and grants the backed membership", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { claimPool } = await provisionExternalClaimPool({
      default_membership_duration_days: 30,
    });
    const token = `claim-token-${uuid()}`;
    const consumption = await consumeVerifiedSiteLicenseExternalClaim({
      issuer: claimPool.issuer,
      site_license_id: claimPool.site_license_id,
      pool_id: claimPool.id,
      jti: uuid(),
      token_hash: hashSiteLicenseExternalClaimToken({ token }),
      account_id,
      external_subject: "order-123",
      token_expires_at: dayjs().add(1, "day").toDate(),
      metadata: { label: "test claim" },
    });

    expect(consumption.status).toBe("granted");
    expect(consumption.assignment_id).toBeTruthy();
    expect(consumption.membership_grant_id).toBeTruthy();
    expect(consumption.rootfs_id).toBe("cocalc.local/rootfs/test");

    const resolved = await resolveMembershipForAccount(account_id);
    expect(resolved.class).toBe(defaultTier);

    const grants = await getPool().query<{
      source: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT source, metadata
         FROM membership_grants
        WHERE id=$1`,
      [consumption.membership_grant_id],
    );
    expect(grants.rows[0]?.source).toBe("site-license-external-claim");
    expect(
      grants.rows[0]?.metadata?.site_license_external_claim_side_effect_key,
    ).toBe(consumption.side_effect_key);
  });

  it("returns the existing granted consumption when the same account retries", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { claimPool } = await provisionExternalClaimPool();
    const jti = uuid();
    const token_hash = hashSiteLicenseExternalClaimToken({
      token: `retry-token-${uuid()}`,
    });
    const first = await consumeVerifiedSiteLicenseExternalClaim({
      issuer: claimPool.issuer,
      site_license_id: claimPool.site_license_id,
      pool_id: claimPool.id,
      jti,
      token_hash,
      account_id,
    });
    const second = await consumeVerifiedSiteLicenseExternalClaim({
      issuer: claimPool.issuer,
      site_license_id: claimPool.site_license_id,
      pool_id: claimPool.id,
      jti,
      token_hash,
      account_id,
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("granted");
    expect(second.assignment_id).toBe(first.assignment_id);
  });

  it("rejects replay of the same token for another account", async () => {
    const first_account_id = uuid();
    const second_account_id = uuid();
    await createTestAccount(first_account_id);
    await createTestAccount(second_account_id);
    const { claimPool } = await provisionExternalClaimPool();
    const jti = uuid();
    const token_hash = hashSiteLicenseExternalClaimToken({
      token: `stolen-token-${uuid()}`,
    });
    await consumeVerifiedSiteLicenseExternalClaim({
      issuer: claimPool.issuer,
      site_license_id: claimPool.site_license_id,
      pool_id: claimPool.id,
      jti,
      token_hash,
      account_id: first_account_id,
    });

    await expect(
      consumeVerifiedSiteLicenseExternalClaim({
        issuer: claimPool.issuer,
        site_license_id: claimPool.site_license_id,
        pool_id: claimPool.id,
        jti,
        token_hash,
        account_id: second_account_id,
      }),
    ).rejects.toThrow("external claim token was already consumed");
  });

  it("allows bounded membership class and expiration overrides", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { claimPool } = await provisionExternalClaimPool({
      allow_membership_class_override: true,
      allow_membership_expires_at_override: true,
      max_membership_duration_days: 90,
    });
    const membership_expires_at = dayjs().add(45, "day").toDate();
    const consumption = await consumeVerifiedSiteLicenseExternalClaim({
      issuer: claimPool.issuer,
      site_license_id: claimPool.site_license_id,
      pool_id: claimPool.id,
      jti: uuid(),
      token_hash: hashSiteLicenseExternalClaimToken({
        token: `override-token-${uuid()}`,
      }),
      account_id,
      membership_class: overrideTier,
      membership_expires_at,
    });

    expect(consumption.membership_class).toBe(overrideTier);
    const grant = await getPool().query<{
      membership_class: string;
      expires_at: Date;
    }>(
      `SELECT membership_class, expires_at
         FROM membership_grants
        WHERE id=$1`,
      [consumption.membership_grant_id],
    );
    expect(grant.rows[0]?.membership_class).toBe(overrideTier);
    expect(dayjs(grant.rows[0]?.expires_at).toISOString()).toBe(
      dayjs(membership_expires_at).toISOString(),
    );
  });

  it("verifies and consumes a compact EdDSA claim token", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { claimPool } = await provisionExternalClaimPool({
      default_membership_duration_days: 30,
    });
    const { kid, privateKey } = await addEdDsaKey(claimPool.id);
    const jti = uuid();
    const token = compactEdDsaToken({
      privateKey,
      kid,
      payload: {
        iss: claimPool.issuer,
        aud: claimPool.audience,
        site_license_id: claimPool.site_license_id,
        pool_id: claimPool.id,
        jti,
        exp: Math.floor(dayjs().add(1, "day").valueOf() / 1000),
        subject: "reader-456",
        label: "CUP sample",
        metadata: { publication: "example" },
      },
    });

    const consumption = await consumeSiteLicenseExternalClaimToken({
      token,
      account_id,
    });

    expect(consumption.status).toBe("granted");
    expect(consumption.kid).toBe(kid);
    expect(consumption.jti).toBe(jti);
    expect(consumption.token_hash).toBe(
      hashSiteLicenseExternalClaimToken({ token }),
    );
    expect(consumption.external_subject).toBe("reader-456");
  });

  it("rejects expired and tampered compact claim tokens before consumption", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { claimPool } = await provisionExternalClaimPool();
    const { kid, privateKey } = await addEdDsaKey(claimPool.id);
    const basePayload = {
      iss: claimPool.issuer,
      aud: claimPool.audience,
      site_license_id: claimPool.site_license_id,
      pool_id: claimPool.id,
      jti: uuid(),
    };
    const expiredToken = compactEdDsaToken({
      privateKey,
      kid,
      payload: {
        ...basePayload,
        exp: Math.floor(dayjs().subtract(1, "minute").valueOf() / 1000),
      },
    });
    await expect(
      consumeSiteLicenseExternalClaimToken({ token: expiredToken, account_id }),
    ).rejects.toThrow("external claim token has expired");

    const validToken = compactEdDsaToken({
      privateKey,
      kid,
      payload: {
        ...basePayload,
        jti: uuid(),
        exp: Math.floor(dayjs().add(1, "day").valueOf() / 1000),
      },
    });
    const parts = validToken.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...basePayload,
        jti: uuid(),
        exp: Math.floor(dayjs().add(1, "day").valueOf() / 1000),
      }),
    ).toString("base64url");
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    await expect(
      consumeSiteLicenseExternalClaimToken({
        token: tamperedToken,
        account_id,
      }),
    ).rejects.toThrow("external claim token signature is invalid");
  });
});
