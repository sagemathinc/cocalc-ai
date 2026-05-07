/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createHmac } from "node:crypto";
import os from "node:os";
import { join } from "node:path";

import { after, before } from "@cocalc/server/test";
import createAccount from "@cocalc/server/accounts/create-account";
import { createRememberMeCookie } from "@cocalc/server/auth/remember-me";
import { recordNewAuthSession } from "@cocalc/server/auth/auth-sessions";
import { base32Decode } from "@cocalc/server/auth/totp";
import {
  confirmTwoFactorSetup,
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
        current_password: password,
        method: "recovery_code",
        code: recovery_code,
        duration: "extended",
      }),
    ).rejects.toThrow(
      "extended fresh auth requires a TOTP verification in this browser session",
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
});
