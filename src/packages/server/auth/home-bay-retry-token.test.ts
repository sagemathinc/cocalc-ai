export {};

describe("auth/home-bay-retry-token", () => {
  const prevSecret = process.env.COCALC_HOME_BAY_RETRY_TOKEN_SECRET;
  const prevClusterShared = process.env.COCALC_CLUSTER_SHARED_SECRET;
  const prevClusterRole = process.env.COCALC_CLUSTER_ROLE;
  const prevSeedConatPassword = process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD;

  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_HOME_BAY_RETRY_TOKEN_SECRET = "test-home-bay-secret";
  });

  afterEach(() => {
    if (prevSecret == null) {
      delete process.env.COCALC_HOME_BAY_RETRY_TOKEN_SECRET;
    } else {
      process.env.COCALC_HOME_BAY_RETRY_TOKEN_SECRET = prevSecret;
    }
    if (prevClusterShared == null) {
      delete process.env.COCALC_CLUSTER_SHARED_SECRET;
    } else {
      process.env.COCALC_CLUSTER_SHARED_SECRET = prevClusterShared;
    }
    if (prevClusterRole == null) {
      delete process.env.COCALC_CLUSTER_ROLE;
    } else {
      process.env.COCALC_CLUSTER_ROLE = prevClusterRole;
    }
    if (prevSeedConatPassword == null) {
      delete process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD;
    } else {
      process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD = prevSeedConatPassword;
    }
  });

  it("verifies seed-issued tokens on an attached bay with distinct local credentials", async () => {
    delete process.env.COCALC_HOME_BAY_RETRY_TOKEN_SECRET;
    process.env.COCALC_CLUSTER_SHARED_SECRET = "cluster-wide-secret";
    process.env.COCALC_CLUSTER_ROLE = "seed";
    process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD = "seed-local-password";
    const { issueHomeBayRetryToken, verifyHomeBayRetryToken } =
      await import("./home-bay-retry-token");
    const issued = issueHomeBayRetryToken({
      email: "user@example.com",
      home_bay_id: "bay-2",
      purpose: "sign-in",
    });
    process.env.COCALC_CLUSTER_ROLE = "attached";
    process.env.COCALC_CLUSTER_SEED_CONAT_PASSWORD = "attached-local-password";
    expect(
      verifyHomeBayRetryToken({
        token: issued.token,
        email: "user@example.com",
        home_bay_id: "bay-2",
        purpose: "sign-in",
      }),
    ).toMatchObject({ home_bay_id: "bay-2", purpose: "sign-in" });
  });

  it("rejects multi-bay tokens without a cluster-wide signing secret", async () => {
    delete process.env.COCALC_HOME_BAY_RETRY_TOKEN_SECRET;
    delete process.env.COCALC_CLUSTER_SHARED_SECRET;
    process.env.COCALC_CLUSTER_ROLE = "attached";
    const { issueHomeBayRetryToken } = await import("./home-bay-retry-token");
    expect(() =>
      issueHomeBayRetryToken({
        email: "user@example.com",
        home_bay_id: "bay-2",
        purpose: "sign-in",
      }),
    ).toThrow("missing shared home-bay retry token signing secret");
  });

  it("round-trips sign-in tokens by email", async () => {
    const { issueHomeBayRetryToken, verifyHomeBayRetryToken } =
      await import("./home-bay-retry-token");
    const issued = issueHomeBayRetryToken({
      email: "user@example.com",
      home_bay_id: "bay-2",
      purpose: "sign-in",
    });

    expect(
      verifyHomeBayRetryToken({
        token: issued.token,
        email: "user@example.com",
        home_bay_id: "bay-2",
        purpose: "sign-in",
      }),
    ).toMatchObject({
      email: "user@example.com",
      home_bay_id: "bay-2",
      purpose: "sign-in",
    });
  });

  it("round-trips impersonation tokens by account id", async () => {
    const { issueHomeBayRetryToken, verifyHomeBayRetryToken } =
      await import("./home-bay-retry-token");
    const issued = issueHomeBayRetryToken({
      account_id: "11111111-1111-1111-1111-111111111111",
      home_bay_id: "bay-2",
      purpose: "impersonate",
    });

    expect(
      verifyHomeBayRetryToken({
        token: issued.token,
        account_id: "11111111-1111-1111-1111-111111111111",
        home_bay_id: "bay-2",
        purpose: "impersonate",
      }),
    ).toMatchObject({
      account_id: "11111111-1111-1111-1111-111111111111",
      home_bay_id: "bay-2",
      purpose: "impersonate",
    });
  });

  it("round-trips password reset tokens by account id", async () => {
    const { issueHomeBayRetryToken, verifyHomeBayRetryToken } =
      await import("./home-bay-retry-token");
    const issued = issueHomeBayRetryToken({
      account_id: "22222222-2222-4222-8222-222222222222",
      home_bay_id: "bay-1",
      purpose: "password-reset",
    });

    expect(
      verifyHomeBayRetryToken({
        token: issued.token,
        account_id: "22222222-2222-4222-8222-222222222222",
        home_bay_id: "bay-1",
        purpose: "password-reset",
      }),
    ).toMatchObject({
      account_id: "22222222-2222-4222-8222-222222222222",
      home_bay_id: "bay-1",
      purpose: "password-reset",
    });
  });

  it("round-trips CLI login tokens by account id and challenge id", async () => {
    const { issueHomeBayRetryToken, verifyHomeBayRetryToken } =
      await import("./home-bay-retry-token");
    const issued = issueHomeBayRetryToken({
      account_id: "33333333-3333-4333-8333-333333333333",
      challenge_id: "44444444-4444-4444-8444-444444444444",
      factor_level: "passkey",
      fresh_auth_until: "2099-05-08T18:00:00.000Z",
      home_bay_id: "bay-2",
      purpose: "cli-login",
    });

    expect(
      verifyHomeBayRetryToken({
        token: issued.token,
        account_id: "33333333-3333-4333-8333-333333333333",
        challenge_id: "44444444-4444-4444-8444-444444444444",
        home_bay_id: "bay-2",
        purpose: "cli-login",
      }),
    ).toMatchObject({
      account_id: "33333333-3333-4333-8333-333333333333",
      challenge_id: "44444444-4444-4444-8444-444444444444",
      factor_level: "passkey",
      fresh_auth_until: "2099-05-08T18:00:00.000Z",
      home_bay_id: "bay-2",
      purpose: "cli-login",
    });
  });
});
