/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createHmac } from "node:crypto";
import os from "node:os";
import { join } from "node:path";

import { after, before } from "@cocalc/server/test";
import getPool from "@cocalc/database/pool";
import createAccount from "@cocalc/server/accounts/create-account";
import { createRememberMeCookie } from "@cocalc/server/auth/remember-me";
import { recordNewAuthSession } from "@cocalc/server/auth/auth-sessions";
import { base32Decode } from "@cocalc/server/auth/totp";
import {
  confirmTwoFactorSetup,
  createSignInSecondFactorChallenge,
  freshAuthSession,
  startTwoFactorSetup,
} from "@cocalc/server/auth/two-factor";
import { uuid } from "@cocalc/util/misc";

function createTotpCode(secret: string, at = Date.now()): string {
  const key = base32Decode(secret);
  const counter = Math.floor(at / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter), 0);
  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return `${binary % 1_000_000}`.padStart(6, "0");
}

function createRequest(rememberMeValue?: string) {
  const cookie = rememberMeValue ? `remember_me=${rememberMeValue}` : "";
  return {
    headers: cookie ? { cookie } : {},
    protocol: "http",
    ip: "127.0.0.1",
    connection: {},
    get: (_name: string) => "",
  } as any;
}

beforeAll(async () => {
  process.env.COCALC_SECRET_SETTINGS_KEY_PATH = join(
    os.tmpdir(),
    `cocalc-secret-settings-key-${uuid()}`,
  );
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("freshAuthSession", () => {
  it("allows adding an authenticator app when a passkey is already active", async () => {
    const account_id = uuid();

    await createAccount({
      email: `${uuid()}@test.com`,
      password: "cocalcrulez",
      firstName: "Passkey",
      lastName: "Only",
      account_id,
    });
    await getPool().query(
      `
        INSERT INTO account_second_factors(
          id, account_id, type, label, secret_encrypted, status, created,
          activated_at, disabled_at, last_used_at, metadata
        ) VALUES(
          $1::UUID, $2::UUID, 'passkey', 'Localhost passkey', 'unused',
          'active', NOW(), NOW(), NULL, NULL, $3::JSONB
        )
      `,
      [uuid(), account_id, JSON.stringify({ credential_id: "credential-1" })],
    );

    const setup = await startTwoFactorSetup({ account_id });
    const confirmed = await confirmTwoFactorSetup({
      req: createRequest(),
      account_id,
      factor_id: setup.factor_id,
      code: createTotpCode(setup.secret),
    });

    expect(confirmed.recovery_codes).toHaveLength(10);
    const factors = (
      await getPool().query<{ type: string }>(
        `
          SELECT type
            FROM account_second_factors
           WHERE account_id = $1::UUID
             AND status = 'active'
           ORDER BY type
        `,
        [account_id],
      )
    ).rows.map((row) => row.type);
    expect(factors).toEqual(["passkey", "totp"]);
  });

  it("does not consume a recovery code when rejecting extended fresh auth", async () => {
    const account_id = uuid();
    const email = `${uuid()}@test.com`;
    const password = "cocalcrulez";

    await createAccount({
      email,
      password,
      firstName: "Test",
      lastName: "User",
      account_id,
    });

    const setup = await startTwoFactorSetup({ account_id });
    const confirmed = await confirmTwoFactorSetup({
      req: createRequest(),
      account_id,
      factor_id: setup.factor_id,
      code: createTotpCode(setup.secret),
    });
    const recovery_code = confirmed.recovery_codes[0];

    const remember = await createRememberMeCookie(account_id, 3600);
    const authenticated_at = new Date();
    await recordNewAuthSession({
      account_id,
      session_hash: remember.hash,
      expire: remember.expire,
      authenticated_at,
      password_verified_at: authenticated_at,
      factor_level: "none",
    });

    const req = createRequest(remember.value);

    await expect(
      freshAuthSession({
        req,
        account_id,
        current_password: "wrong-password",
        method: "totp",
        code: createTotpCode(setup.secret),
      }),
    ).resolves.toMatchObject({
      factor_level: "totp",
    });

    await expect(
      freshAuthSession({
        req,
        account_id,
        current_password: password,
        method: "recovery_code",
        code: recovery_code,
        duration: "extended",
      }),
    ).rejects.toThrow(
      "extended fresh auth requires a TOTP or passkey verification in this browser session",
    );

    await expect(
      freshAuthSession({
        req,
        account_id,
        current_password: password,
        method: "recovery_code",
        code: recovery_code,
      }),
    ).resolves.toMatchObject({
      factor_level: "recovery_code",
    });
  });

  it("still requires a valid password when no second factor is enabled", async () => {
    const account_id = uuid();
    const email = `${uuid()}@test.com`;
    const password = "cocalcrulez";

    await createAccount({
      email,
      password,
      firstName: "Test",
      lastName: "User",
      account_id,
    });

    const remember = await createRememberMeCookie(account_id, 3600);
    const authenticated_at = new Date();
    await recordNewAuthSession({
      account_id,
      session_hash: remember.hash,
      expire: remember.expire,
      authenticated_at,
      password_verified_at: authenticated_at,
      factor_level: "none",
    });

    const req = createRequest(remember.value);

    await expect(
      freshAuthSession({
        req,
        account_id,
        current_password: "wrong-password",
      }),
    ).rejects.toThrow("current password is incorrect");
  });

  it("does not fresh-authenticate passwordless accounts without a second factor", async () => {
    const account_id = uuid();

    await createAccount({
      email: `${uuid()}@test.com`,
      firstName: "SSO",
      lastName: "Only",
      account_id,
    });

    const remember = await createRememberMeCookie(account_id, 3600);
    await recordNewAuthSession({
      account_id,
      session_hash: remember.hash,
      expire: remember.expire,
      authenticated_at: new Date(),
      password_verified_at: null,
      factor_level: "none",
    });

    await expect(
      freshAuthSession({
        req: createRequest(remember.value),
        account_id,
        current_password: "",
      }),
    ).rejects.toThrow(
      "fresh authentication requires a password or second factor",
    );
  });
});

describe("sign-in second factor challenges", () => {
  it("caps failed attempts across repeated challenges", async () => {
    const account_id = uuid();
    const email = `${uuid()}@test.com`;
    const password = "cocalcrulez";

    await createAccount({
      email,
      password,
      firstName: "Test",
      lastName: "User",
      account_id,
    });

    const setup = await startTwoFactorSetup({ account_id });
    await confirmTwoFactorSetup({
      req: createRequest(),
      account_id,
      factor_id: setup.factor_id,
      code: createTotpCode(setup.secret),
    });

    await getPool().query(
      `
        INSERT INTO account_auth_challenges(
          id,
          account_id,
          purpose,
          password_verified_at,
          factor_verified_at,
          verified_factor_type,
          target_session_hash,
          expire,
          attempt_count,
          max_attempts,
          completed_at,
          created,
          metadata
        ) VALUES(
          $1::UUID,
          $2::UUID,
          'sign_in',
          NOW(),
          NULL,
          NULL,
          NULL,
          NOW() + INTERVAL '10 minutes',
          32,
          8,
          NULL,
          NOW(),
          '{}'::JSONB
        )
      `,
      [uuid(), account_id],
    );

    await expect(
      createSignInSecondFactorChallenge({ account_id }),
    ).rejects.toThrow("too many recent second factor attempts");
  });
});
