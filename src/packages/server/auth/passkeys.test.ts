/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import os from "node:os";
import { join } from "node:path";

import { after, before } from "@cocalc/server/test";
import createAccount from "@cocalc/server/accounts/create-account";
import getPool from "@cocalc/database/pool";
import { createRememberMeCookie } from "@cocalc/server/auth/remember-me";
import {
  FRESH_AUTH_DEFAULT_MS,
  recordNewAuthSession,
} from "@cocalc/server/auth/auth-sessions";
import { hasActiveSecondFactor } from "@cocalc/server/auth/two-factor";
import {
  createSignInSecondFactorChallenge,
  verifySignInSecondFactorChallenge,
} from "@cocalc/server/auth/two-factor";
import {
  finishFreshAuthPasskeyAuthentication,
  finishPasskeySetup,
  finishSignInPasskeyAuthentication,
  listPasskeys,
  startFreshAuthPasskeyAuthentication,
  startSignInPasskeyAuthentication,
  startPasskeySetup,
} from "@cocalc/server/auth/passkeys";
import { uuid } from "@cocalc/util/misc";

jest.mock("@simplewebauthn/server", () => ({
  __esModule: true,
  generateRegistrationOptions: jest.fn(async () => ({
    challenge: "registration-challenge",
    rp: { id: "localhost", name: "CoCalc" },
    user: {
      id: "user-id",
      name: "user@example.com",
      displayName: "User Example",
    },
    pubKeyCredParams: [],
  })),
  generateAuthenticationOptions: jest.fn(async () => ({
    challenge: "authentication-challenge",
    rpId: "localhost",
    allowCredentials: [{ id: "credential-id", type: "public-key" }],
    userVerification: "preferred",
  })),
  verifyRegistrationResponse: jest.fn(async () => ({
    verified: true,
    registrationInfo: {
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: {
        id: "credential-id",
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 7,
      },
      credentialBackedUp: true,
      credentialDeviceType: "multiDevice",
      origin: "http://localhost",
      rpID: "localhost",
      userVerified: true,
    },
  })),
  verifyAuthenticationResponse: jest.fn(async () => ({
    verified: true,
    authenticationInfo: {
      credentialID: "credential-id",
      newCounter: 8,
      credentialBackedUp: true,
      credentialDeviceType: "multiDevice",
      origin: "http://localhost",
      rpID: "localhost",
      userVerified: true,
    },
  })),
}));

function createRequest(rememberMeValue?: string) {
  const cookie = rememberMeValue ? `remember_me=${rememberMeValue}` : "";
  return {
    headers: {
      ...(cookie ? { cookie } : {}),
      host: "localhost",
    },
    protocol: "http",
    ip: "127.0.0.1",
    connection: {},
    get: (_name: string) => "",
  } as any;
}

async function createFreshSession(account_id: string) {
  const remember = await createRememberMeCookie(account_id, 3600);
  const authenticated_at = new Date();
  await recordNewAuthSession({
    account_id,
    session_hash: remember.hash,
    expire: remember.expire,
    authenticated_at,
    password_verified_at: authenticated_at,
    fresh_auth_until: new Date(Date.now() + FRESH_AUTH_DEFAULT_MS),
    factor_level: "none",
  });
  return remember;
}

async function expireFreshAuthSession(
  account_id: string,
  session_hash: string,
) {
  await getPool().query(
    `
      UPDATE account_auth_sessions
         SET fresh_auth_until = NOW() - INTERVAL '1 minute'
       WHERE account_id = $1::UUID
         AND session_hash = $2::CHAR(127)
    `,
    [account_id, session_hash],
  );
}

function registrationResponse() {
  return {
    id: "credential-id",
    rawId: "credential-id",
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: "client-data",
      attestationObject: "attestation",
      transports: ["internal"],
    },
  } as const;
}

beforeAll(async () => {
  process.env.COCALC_SECRET_SETTINGS_KEY_PATH = join(
    os.tmpdir(),
    `cocalc-secret-settings-key-${uuid()}`,
  );
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("passkey setup", () => {
  it("creates an active passkey and marks the account as 2FA-enabled", async () => {
    const account_id = uuid();
    const password = "cocalcrulez";
    await createAccount({
      email: `${uuid()}@test.com`,
      password,
      firstName: "Passkey",
      lastName: "User",
      account_id,
    });
    const remember = await createFreshSession(account_id);
    const req = createRequest(remember.value);

    const setup = await startPasskeySetup({
      req,
      account_id,
      label: "Laptop",
    });
    expect(setup.challenge_id).toBeTruthy();
    expect(setup.options.challenge).toBe("registration-challenge");

    const result = await finishPasskeySetup({
      req,
      account_id,
      challenge_id: setup.challenge_id,
      label: "Laptop",
      response: registrationResponse(),
    });

    expect(result.passkey).toMatchObject({
      label: "Laptop",
      credential_id: "credential-id",
      backed_up: true,
      device_type: "multiDevice",
    });
    expect(result.recovery_codes).toHaveLength(10);
    await expect(hasActiveSecondFactor(account_id)).resolves.toBe(true);
    await expect(listPasskeys({ account_id })).resolves.toMatchObject({
      passkeys: [
        {
          label: "Laptop",
          credential_id: "credential-id",
        },
      ],
    });

    const recoveryChallenge = await createSignInSecondFactorChallenge({
      account_id,
    });
    await expect(
      verifySignInSecondFactorChallenge({
        challenge_id: recoveryChallenge.challenge_id,
        method: "recovery_code",
        code: result.recovery_codes[0],
      }),
    ).resolves.toMatchObject({
      account_id,
      factor_level: "recovery_code",
    });

    const signInChallenge = await createSignInSecondFactorChallenge({
      account_id,
    });
    expect(signInChallenge.methods).toContain("passkey");

    const authStart = await startSignInPasskeyAuthentication({
      req,
      challenge_id: signInChallenge.challenge_id,
    });
    expect(authStart.options.challenge).toBe("authentication-challenge");

    await expect(
      finishSignInPasskeyAuthentication({
        challenge_id: signInChallenge.challenge_id,
        response: {
          id: "credential-id",
          rawId: "credential-id",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: "client-data",
            authenticatorData: "authenticator-data",
            signature: "signature",
          },
        },
      }),
    ).resolves.toMatchObject({
      account_id,
      factor_level: "passkey",
    });

    const freshStart = await startFreshAuthPasskeyAuthentication({
      req,
      account_id,
      current_password: password,
      duration: "extended",
    });
    expect(freshStart.options.challenge).toBe("authentication-challenge");

    await expect(
      finishFreshAuthPasskeyAuthentication({
        req,
        account_id,
        challenge_id: freshStart.challenge_id,
        response: {
          id: "credential-id",
          rawId: "credential-id",
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: "client-data",
            authenticatorData: "authenticator-data",
            signature: "signature",
          },
        },
      }),
    ).resolves.toMatchObject({
      factor_level: "passkey",
    });
  });

  it("requires fresh auth when finishing passkey setup", async () => {
    const account_id = uuid();
    await createAccount({
      email: `${uuid()}@test.com`,
      password: "cocalcrulez",
      firstName: "Passkey",
      lastName: "Stale",
      account_id,
    });
    const remember = await createFreshSession(account_id);
    const req = createRequest(remember.value);
    const setup = await startPasskeySetup({
      req,
      account_id,
      label: "Laptop",
    });

    await expireFreshAuthSession(account_id, remember.hash);

    await expect(
      finishPasskeySetup({
        req,
        account_id,
        challenge_id: setup.challenge_id,
        label: "Laptop",
        response: registrationResponse(),
      }),
    ).rejects.toThrow("fresh auth is required");
  });

  it("rejects passkey setup completion from a different browser session", async () => {
    const account_id = uuid();
    await createAccount({
      email: `${uuid()}@test.com`,
      password: "cocalcrulez",
      firstName: "Passkey",
      lastName: "Mismatch",
      account_id,
    });
    const setupSession = await createFreshSession(account_id);
    const otherSession = await createFreshSession(account_id);
    const setupReq = createRequest(setupSession.value);
    const otherReq = createRequest(otherSession.value);
    const setup = await startPasskeySetup({
      req: setupReq,
      account_id,
      label: "Laptop",
    });

    await expect(
      finishPasskeySetup({
        req: otherReq,
        account_id,
        challenge_id: setup.challenge_id,
        label: "Laptop",
        response: registrationResponse(),
      }),
    ).rejects.toThrow("passkey setup challenge target session mismatch");
  });
});
