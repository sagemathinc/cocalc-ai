export {};

describe("auth/home-bay-retry-token", () => {
  const prevSecret = process.env.COCALC_HOME_BAY_RETRY_TOKEN_SECRET;

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
      home_bay_id: "bay-2",
      purpose: "cli-login",
    });
  });
});
