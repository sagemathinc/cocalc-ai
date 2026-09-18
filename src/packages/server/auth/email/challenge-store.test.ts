/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";

const sendEmailAuthChallengeMessageMock = jest.fn(async () => undefined);
const getClusterAccountByEmailDirectMock = jest.fn(async () => null);
const adminVerifyClusterAccountEmailAddressMock = jest.fn(
  async () => undefined,
);
const createClusterAccountMock = jest.fn();
const getServerSettingsMock = jest.fn();
const getStrategiesMock = jest.fn();
const getEnabledSsoDomainPolicyForEmailMock = jest.fn();
const getRequiresRegistrationTokenMock = jest.fn();
const validateRegistrationTokenDirectMock = jest.fn();
const redeemRegistrationTokenDirectMock = jest.fn();
const restoreRedeemedRegistrationTokenDirectMock = jest.fn();
const issueHomeBayRetryTokenMock = jest.fn(({ token_id }) => ({
  token: `signed-${token_id}-${"x".repeat(40)}`,
  expires_at: Date.now() + 60_000,
}));

jest.mock("./delivery", () => ({
  sendEmailAuthChallengeMessage: (...args: any[]) =>
    sendEmailAuthChallengeMessageMock(...args),
}));

jest.mock("@cocalc/server/accounts/cluster-directory", () => ({
  getClusterAccountByEmailDirect: (...args: any[]) =>
    getClusterAccountByEmailDirectMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  adminVerifyClusterAccountEmailAddress: (...args: any[]) =>
    adminVerifyClusterAccountEmailAddressMock(...args),
  createClusterAccount: (...args: any[]) => createClusterAccountMock(...args),
}));

jest.mock("@cocalc/server/auth/home-bay-retry-token", () => ({
  issueHomeBayRetryToken: (...args: any[]) =>
    issueHomeBayRetryTokenMock(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/database/settings/get-sso-strategies", () => ({
  __esModule: true,
  default: (...args: any[]) => getStrategiesMock(...args),
}));

jest.mock("@cocalc/database/settings/sso-policies", () => ({
  getEnabledSsoDomainPolicyForEmail: (...args: any[]) =>
    getEnabledSsoDomainPolicyForEmailMock(...args),
  passwordSignupBlockedBySsoPolicy: () => false,
}));

jest.mock("@cocalc/server/auth/tokens/get-requires-token", () => ({
  __esModule: true,
  default: (...args: any[]) => getRequiresRegistrationTokenMock(...args),
}));

jest.mock("@cocalc/server/auth/tokens/redeem", () => ({
  validateRegistrationTokenDirect: (...args: any[]) =>
    validateRegistrationTokenDirectMock(...args),
  redeemRegistrationTokenDirect: (...args: any[]) =>
    redeemRegistrationTokenDirectMock(...args),
  restoreRedeemedRegistrationTokenDirect: (...args: any[]) =>
    restoreRedeemedRegistrationTokenDirectMock(...args),
}));

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  getSecretSettingsKey: async () => Buffer.alloc(32, 7),
}));

describe("seed-global email authentication challenges", () => {
  beforeAll(async () => {
    await initEphemeralDatabase();
    const { ensureEmailAuthChallengeSchema } =
      await import("./challenge-store");
    await ensureEmailAuthChallengeSchema();
  }, 20_000);

  beforeEach(async () => {
    sendEmailAuthChallengeMessageMock.mockClear();
    getClusterAccountByEmailDirectMock.mockClear();
    getClusterAccountByEmailDirectMock.mockResolvedValue(null);
    adminVerifyClusterAccountEmailAddressMock.mockClear();
    createClusterAccountMock.mockReset();
    issueHomeBayRetryTokenMock.mockClear();
    getServerSettingsMock.mockReset().mockResolvedValue({
      email_signup: true,
    });
    getStrategiesMock.mockReset().mockResolvedValue([]);
    getEnabledSsoDomainPolicyForEmailMock.mockReset().mockResolvedValue(null);
    getRequiresRegistrationTokenMock.mockReset().mockResolvedValue(false);
    validateRegistrationTokenDirectMock.mockReset().mockResolvedValue({
      token: "registration-token",
    });
    redeemRegistrationTokenDirectMock.mockReset().mockResolvedValue({
      token: "registration-token",
    });
    restoreRedeemedRegistrationTokenDirectMock
      .mockReset()
      .mockResolvedValue(undefined);
    await getPool().query("TRUNCATE email_auth_challenges");
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("stores only digests and proves an email with a six-digit code", async () => {
    const {
      getEmailAuthChallengeStatusDirect,
      redeemEmailAuthCodeDirect,
      startEmailAuthChallengeDirect,
    } = await import("./challenge-store");
    const started = await startEmailAuthChallengeDirect({
      email_address: "Person@Example.EDU",
      browser_binding: "browser-one",
      request_ip: "192.0.2.10",
    });
    expect(started).toMatchObject({
      state: "pending",
      masked_email: "pe…@example.edu",
      send_count: 1,
      message_sent: true,
      message_sent_now: true,
    });
    expect(sendEmailAuthChallengeMessageMock).toHaveBeenCalledTimes(1);
    const sent = sendEmailAuthChallengeMessageMock.mock.calls[0][0];
    expect(sent.code).toMatch(/^\d{6}$/);
    expect(sent.link_token.length).toBeGreaterThanOrEqual(32);

    const { rows } = await getPool().query(
      `SELECT normalized_email, code_digest, link_token_digest,
              browser_binding_digest, request_ip_hash
         FROM email_auth_challenges
        WHERE challenge_id=$1`,
      [started.challenge_id],
    );
    expect(rows[0].normalized_email).toBe("person@example.edu");
    expect(rows[0].code_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].link_token_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].browser_binding_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].request_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(sent.code);
    expect(JSON.stringify(rows[0])).not.toContain(sent.link_token);
    const { emailAuthSecretMatches } = await import("./secrets");
    await expect(
      emailAuthSecretMatches({
        challenge_id: started.challenge_id,
        digest: rows[0].code_digest,
        kind: "code",
        value: sent.code,
      }),
    ).resolves.toBe(true);

    await expect(
      getEmailAuthChallengeStatusDirect({
        challenge_id: started.challenge_id,
        browser_binding: "wrong-browser",
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      redeemEmailAuthCodeDirect({
        challenge_id: started.challenge_id,
        code: sent.code,
      }),
    ).resolves.toMatchObject({ state: "email_proved" });
    await expect(
      redeemEmailAuthCodeDirect({
        challenge_id: started.challenge_id,
        code: sent.code,
      }),
    ).resolves.toMatchObject({ state: "email_proved" });
  });

  it("reuses a same-browser active challenge without sending again", async () => {
    const { startEmailAuthChallengeDirect } = await import("./challenge-store");
    const first = await startEmailAuthChallengeDirect({
      email_address: "person@example.edu",
      browser_binding: "browser-one",
    });
    const second = await startEmailAuthChallengeDirect({
      email_address: "person@example.edu",
      browser_binding: "browser-one",
    });
    expect(second.challenge_id).toBe(first.challenge_id);
    expect(second.message_sent_now).toBe(false);
    expect(sendEmailAuthChallengeMessageMock).toHaveBeenCalledTimes(1);
  });

  it("supersedes an active challenge started from another browser", async () => {
    const { startEmailAuthChallengeDirect } = await import("./challenge-store");
    const first = await startEmailAuthChallengeDirect({
      email_address: "person@example.edu",
      browser_binding: "browser-one",
    });
    const second = await startEmailAuthChallengeDirect({
      email_address: "person@example.edu",
      browser_binding: "browser-two",
    });
    expect(second.challenge_id).not.toBe(first.challenge_id);
    const { rows } = await getPool().query(
      `SELECT state FROM email_auth_challenges WHERE challenge_id=$1`,
      [first.challenge_id],
    );
    expect(rows[0].state).toBe("superseded");
  });

  it("records failed attempts and blocks the eighth invalid code", async () => {
    const { redeemEmailAuthCodeDirect, startEmailAuthChallengeDirect } =
      await import("./challenge-store");
    const started = await startEmailAuthChallengeDirect({
      email_address: "person@example.edu",
      browser_binding: "browser-one",
    });
    for (let i = 0; i < 7; i += 1) {
      await expect(
        redeemEmailAuthCodeDirect({
          challenge_id: started.challenge_id,
          code: `${100000 + i}`,
        }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(
      redeemEmailAuthCodeDirect({
        challenge_id: started.challenge_id,
        code: "100007",
      }),
    ).rejects.toMatchObject({ code: "blocked" });
    const { rows } = await getPool().query(
      `SELECT state, attempt_count FROM email_auth_challenges WHERE challenge_id=$1`,
      [started.challenge_id],
    );
    expect(rows[0]).toMatchObject({ state: "blocked", attempt_count: 8 });
  });

  it("does not allow an immediate resend", async () => {
    const { resendEmailAuthChallengeDirect, startEmailAuthChallengeDirect } =
      await import("./challenge-store");
    const started = await startEmailAuthChallengeDirect({
      email_address: "person@example.edu",
      browser_binding: "browser-one",
    });
    await expect(
      resendEmailAuthChallengeDirect({
        challenge_id: started.challenge_id,
        browser_binding: "browser-one",
      }),
    ).rejects.toMatchObject({ code: "resend_too_soon" });
  });

  it("prepares and consumes a one-time home-bay exchange", async () => {
    getClusterAccountByEmailDirectMock.mockResolvedValue({
      account_id: "22222222-2222-4222-8222-222222222222",
      email_address: "person@example.edu",
      home_bay_id: "bay-home",
      banned: false,
    });
    const {
      consumeEmailAuthExchangeDirect,
      prepareEmailAuthExchangeDirect,
      redeemEmailAuthCodeDirect,
      startEmailAuthChallengeDirect,
    } = await import("./challenge-store");
    const started = await startEmailAuthChallengeDirect({
      email_address: "person@example.edu",
      browser_binding: "browser-one",
      continuation_target: "/projects/project-id/files",
      prospective_home_bay_id: "bay-new",
      terms_accepted: true,
    });
    const sent = sendEmailAuthChallengeMessageMock.mock.calls[0][0];
    await redeemEmailAuthCodeDirect({
      challenge_id: started.challenge_id,
      code: sent.code,
    });
    const exchange = await prepareEmailAuthExchangeDirect({
      challenge_id: started.challenge_id,
      auth_method: "email_code",
    });
    expect(exchange).toMatchObject({
      account_created: false,
      challenge_id: started.challenge_id,
      home_bay_id: "bay-home",
      redirect_to: "/projects/project-id/files",
      state: "account_ready",
    });
    expect(exchange.exchange_token).toContain("signed-");
    expect(adminVerifyClusterAccountEmailAddressMock).toHaveBeenCalledWith({
      account_id: "22222222-2222-4222-8222-222222222222",
      email_address: "person@example.edu",
    });

    const tokenArgs = issueHomeBayRetryTokenMock.mock.calls.at(-1)?.[0];
    const consumed = await consumeEmailAuthExchangeDirect({
      account_id: "22222222-2222-4222-8222-222222222222",
      challenge_id: started.challenge_id,
      completion: "completed",
      exchange_id: tokenArgs.token_id,
      home_bay_id: "bay-home",
    });
    expect(consumed).toMatchObject({
      account_id: "22222222-2222-4222-8222-222222222222",
      auth_method: "email_code",
    });
    await expect(
      consumeEmailAuthExchangeDirect({
        account_id: consumed.account_id,
        challenge_id: started.challenge_id,
        completion: "completed",
        exchange_id: tokenArgs.token_id,
        home_bay_id: "bay-home",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("marks an MFA-backed exchange complete only after the second factor", async () => {
    getClusterAccountByEmailDirectMock.mockResolvedValue({
      account_id: "22222222-2222-4222-8222-222222222222",
      email_address: "person@example.edu",
      home_bay_id: "bay-home",
      banned: false,
    });
    const {
      completeEmailAuthMfaDirect,
      consumeEmailAuthExchangeDirect,
      prepareEmailAuthExchangeDirect,
      redeemEmailAuthCodeDirect,
      startEmailAuthChallengeDirect,
    } = await import("./challenge-store");
    const started = await startEmailAuthChallengeDirect({
      email_address: "person@example.edu",
      browser_binding: "browser-one",
      prospective_home_bay_id: "bay-new",
      terms_accepted: true,
    });
    await redeemEmailAuthCodeDirect({
      challenge_id: started.challenge_id,
      code: sendEmailAuthChallengeMessageMock.mock.calls[0][0].code,
    });
    await prepareEmailAuthExchangeDirect({
      challenge_id: started.challenge_id,
      auth_method: "email_code",
    });
    const tokenArgs = issueHomeBayRetryTokenMock.mock.calls.at(-1)?.[0];
    await consumeEmailAuthExchangeDirect({
      account_id: "22222222-2222-4222-8222-222222222222",
      challenge_id: started.challenge_id,
      completion: "mfa_required",
      exchange_id: tokenArgs.token_id,
      home_bay_id: "bay-home",
    });

    await completeEmailAuthMfaDirect({
      account_id: "22222222-2222-4222-8222-222222222222",
      challenge_id: started.challenge_id,
      home_bay_id: "bay-home",
    });

    const { rows } = await getPool().query(
      `SELECT state, completed_at, session_completed_at
         FROM email_auth_challenges
        WHERE challenge_id=$1`,
      [started.challenge_id],
    );
    expect(rows[0].state).toBe("completed");
    expect(rows[0].completed_at).not.toBeNull();
    expect(rows[0].session_completed_at).not.toBeNull();
    await expect(
      completeEmailAuthMfaDirect({
        account_id: "22222222-2222-4222-8222-222222222222",
        challenge_id: started.challenge_id,
        home_bay_id: "bay-home",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("creates a verified account without a password only after proof", async () => {
    createClusterAccountMock.mockResolvedValue({
      account_id: "33333333-3333-4333-8333-333333333333",
      email_address: "new@example.edu",
      home_bay_id: "bay-new",
    });
    const {
      prepareEmailAuthExchangeDirect,
      redeemEmailAuthLinkDirect,
      startEmailAuthChallengeDirect,
    } = await import("./challenge-store");
    const started = await startEmailAuthChallengeDirect({
      email_address: "new@example.edu",
      browser_binding: "browser-new",
      prospective_home_bay_id: "bay-new",
      terms_accepted: true,
      terms_version: "2026-07",
      onboarding_intent: "sage",
    });
    const sent = sendEmailAuthChallengeMessageMock.mock.calls[0][0];
    await redeemEmailAuthLinkDirect({
      challenge_id: started.challenge_id,
      token: sent.link_token,
    });
    const exchange = await prepareEmailAuthExchangeDirect({
      challenge_id: started.challenge_id,
      auth_method: "email_link",
    });

    expect(exchange.account_created).toBe(true);
    expect(createClusterAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email_address: "new@example.edu",
        display_name: "CoCalc User",
        home_bay_id: "bay-new",
        signup_reason: "sage",
        other_settings: expect.objectContaining({
          first_run_onboarding_intent_v1: "sage",
        }),
        verified_email: expect.objectContaining({
          address: "new@example.edu",
          method: "email_link",
        }),
      }),
    );
    expect(createClusterAccountMock.mock.calls[0][0]).not.toHaveProperty(
      "password",
    );
    expect(adminVerifyClusterAccountEmailAddressMock).toHaveBeenCalledWith({
      account_id: "33333333-3333-4333-8333-333333333333",
      email_address: "new@example.edu",
    });
  });

  it("reserves and redeems a registration token only after email proof", async () => {
    getRequiresRegistrationTokenMock.mockResolvedValue(true);
    validateRegistrationTokenDirectMock.mockResolvedValue({
      token: "course-token",
      ephemeral: 86_400,
    });
    redeemRegistrationTokenDirectMock.mockResolvedValue({
      token: "course-token",
      ephemeral: 86_400,
    });
    createClusterAccountMock.mockResolvedValue({
      account_id: "44444444-4444-4444-8444-444444444444",
      email_address: "student@example.edu",
      home_bay_id: "bay-new",
    });
    const {
      prepareEmailAuthExchangeDirect,
      redeemEmailAuthCodeDirect,
      startEmailAuthChallengeDirect,
    } = await import("./challenge-store");
    const started = await startEmailAuthChallengeDirect({
      email_address: "student@example.edu",
      browser_binding: "browser-token",
      prospective_home_bay_id: "bay-new",
      registration_token: "course-token",
      terms_accepted: true,
    });

    expect(validateRegistrationTokenDirectMock).toHaveBeenCalledWith(
      "course-token",
      { required: true },
    );
    expect(redeemRegistrationTokenDirectMock).not.toHaveBeenCalled();
    const { rows } = await getPool().query(
      `SELECT registration_token_reservation_id,
              registration_token_encrypted,
              registration_token_validated_at
         FROM email_auth_challenges
        WHERE challenge_id=$1`,
      [started.challenge_id],
    );
    expect(rows[0].registration_token_reservation_id).not.toBeNull();
    expect(rows[0].registration_token_validated_at).not.toBeNull();
    expect(rows[0].registration_token_encrypted).not.toContain("course-token");

    await redeemEmailAuthCodeDirect({
      challenge_id: started.challenge_id,
      code: sendEmailAuthChallengeMessageMock.mock.calls[0][0].code,
    });
    await prepareEmailAuthExchangeDirect({
      challenge_id: started.challenge_id,
      auth_method: "email_code",
    });

    expect(redeemRegistrationTokenDirectMock).toHaveBeenCalledWith(
      "course-token",
      { required: true },
    );
    expect(createClusterAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email_address: "student@example.edu",
        ephemeral: 86_400,
        trusted_product_access: true,
        trusted_product_access_reason: "registration_token",
      }),
    );
    const ready = await getPool().query(
      `SELECT account_created_at, registration_token_encrypted
         FROM email_auth_challenges
        WHERE challenge_id=$1`,
      [started.challenge_id],
    );
    expect(ready.rows[0].account_created_at).not.toBeNull();
    expect(ready.rows[0].registration_token_encrypted).toBeNull();
  });

  it("allows an existing account to use email auth without a registration token", async () => {
    getRequiresRegistrationTokenMock.mockResolvedValue(true);
    getClusterAccountByEmailDirectMock.mockResolvedValue({
      account_id: "22222222-2222-4222-8222-222222222222",
      email_address: "person@example.edu",
      home_bay_id: "bay-home",
      banned: false,
    });
    const {
      prepareEmailAuthExchangeDirect,
      redeemEmailAuthCodeDirect,
      startEmailAuthChallengeDirect,
    } = await import("./challenge-store");
    const started = await startEmailAuthChallengeDirect({
      email_address: "person@example.edu",
      browser_binding: "browser-existing",
      prospective_home_bay_id: "bay-new",
      terms_accepted: true,
    });
    await redeemEmailAuthCodeDirect({
      challenge_id: started.challenge_id,
      code: sendEmailAuthChallengeMessageMock.mock.calls[0][0].code,
    });
    await expect(
      prepareEmailAuthExchangeDirect({
        challenge_id: started.challenge_id,
        auth_method: "email_code",
      }),
    ).resolves.toMatchObject({
      home_bay_id: "bay-home",
      state: "account_ready",
    });
    expect(validateRegistrationTokenDirectMock).not.toHaveBeenCalled();
    expect(redeemRegistrationTokenDirectMock).not.toHaveBeenCalled();
    expect(createClusterAccountMock).not.toHaveBeenCalled();
  });

  it("restores a redeemed token when account creation fails", async () => {
    getRequiresRegistrationTokenMock.mockResolvedValue(true);
    createClusterAccountMock.mockRejectedValue(
      new Error("account creation failed"),
    );
    const {
      prepareEmailAuthExchangeDirect,
      redeemEmailAuthCodeDirect,
      startEmailAuthChallengeDirect,
    } = await import("./challenge-store");
    const started = await startEmailAuthChallengeDirect({
      email_address: "failed@example.edu",
      browser_binding: "browser-failed",
      prospective_home_bay_id: "bay-new",
      registration_token: "registration-token",
      terms_accepted: true,
    });
    await redeemEmailAuthCodeDirect({
      challenge_id: started.challenge_id,
      code: sendEmailAuthChallengeMessageMock.mock.calls[0][0].code,
    });

    await expect(
      prepareEmailAuthExchangeDirect({
        challenge_id: started.challenge_id,
        auth_method: "email_code",
      }),
    ).rejects.toThrow("account creation failed");
    expect(restoreRedeemedRegistrationTokenDirectMock).toHaveBeenCalledWith(
      "registration-token",
    );
  });

  it("binds fresh-auth email proof to an existing account", async () => {
    getClusterAccountByEmailDirectMock.mockResolvedValue({
      account_id: "22222222-2222-4222-8222-222222222222",
      email_address: "person@example.edu",
      home_bay_id: "bay-home",
      banned: false,
    });
    const {
      completeEmailFreshAuthDirect,
      redeemEmailAuthCodeDirect,
      startEmailAuthChallengeDirect,
    } = await import("./challenge-store");
    await expect(
      startEmailAuthChallengeDirect({
        email_address: "person@example.edu",
        browser_binding: "browser-fresh",
        expected_account_id: "99999999-9999-4999-8999-999999999999",
        purpose: "email_fresh_auth",
      }),
    ).rejects.toMatchObject({ code: "not_allowed" });

    const started = await startEmailAuthChallengeDirect({
      email_address: "person@example.edu",
      browser_binding: "browser-fresh",
      expected_account_id: "22222222-2222-4222-8222-222222222222",
      purpose: "email_fresh_auth",
    });
    expect(started.purpose).toBe("email_fresh_auth");
    await redeemEmailAuthCodeDirect({
      challenge_id: started.challenge_id,
      code: sendEmailAuthChallengeMessageMock.mock.calls.at(-1)?.[0].code,
    });
    await expect(
      completeEmailFreshAuthDirect({
        account_id: "99999999-9999-4999-8999-999999999999",
        challenge_id: started.challenge_id,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      completeEmailFreshAuthDirect({
        account_id: "22222222-2222-4222-8222-222222222222",
        challenge_id: started.challenge_id,
      }),
    ).resolves.toMatchObject({
      auth_method: "email_code",
    });
  });
});
