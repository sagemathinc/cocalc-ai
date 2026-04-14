export {};

let queryMock: jest.Mock;
let setSignInCookiesMock: jest.Mock;
let getClusterAccountByIdMock: jest.Mock;
let getBayPublicOriginForRequestMock: jest.Mock;
let getSitePublicOriginForRequestMock: jest.Mock;
let clientSideRedirectMock: jest.Mock;
let issueHomeBayRetryTokenMock: jest.Mock;
let verifyHomeBayRetryTokenMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/auth/set-sign-in-cookies", () => ({
  __esModule: true,
  default: (...args: any[]) => setSignInCookiesMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  __esModule: true,
  getClusterAccountById: (...args: any[]) => getClusterAccountByIdMock(...args),
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  __esModule: true,
  getBayPublicOriginForRequest: (...args: any[]) =>
    getBayPublicOriginForRequestMock(...args),
  getSitePublicOriginForRequest: (...args: any[]) =>
    getSitePublicOriginForRequestMock(...args),
}));

jest.mock("@cocalc/server/auth/client-side-redirect", () => ({
  __esModule: true,
  default: (...args: any[]) => clientSideRedirectMock(...args),
}));

jest.mock("@cocalc/server/auth/home-bay-retry-token", () => ({
  __esModule: true,
  issueHomeBayRetryToken: (...args: any[]) =>
    issueHomeBayRetryTokenMock(...args),
  verifyHomeBayRetryToken: (...args: any[]) =>
    verifyHomeBayRetryTokenMock(...args),
}));

describe("auth/impersonate", () => {
  let prevBayId: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    prevBayId = process.env.COCALC_BAY_ID;
    process.env.COCALC_BAY_ID = "bay-0";
    queryMock = jest.fn(async () => ({
      rows: [{ account_id: "11111111-1111-1111-1111-111111111111" }],
    }));
    setSignInCookiesMock = jest.fn(async () => undefined);
    getClusterAccountByIdMock = jest.fn(async () => ({
      account_id: "11111111-1111-1111-1111-111111111111",
      home_bay_id: "bay-2",
    }));
    getBayPublicOriginForRequestMock = jest.fn(
      async () => "https://bay-2-lite4b.cocalc.ai",
    );
    getSitePublicOriginForRequestMock = jest.fn(
      async () => "https://lite4b.cocalc.ai",
    );
    clientSideRedirectMock = jest.fn();
    issueHomeBayRetryTokenMock = jest.fn(() => ({
      token: "retry-token",
    }));
    verifyHomeBayRetryTokenMock = jest.fn();
  });

  afterEach(() => {
    if (prevBayId == null) {
      delete process.env.COCALC_BAY_ID;
    } else {
      process.env.COCALC_BAY_ID = prevBayId;
    }
  });

  it("hands remote-home-bay impersonation off with a retry token", async () => {
    const { signInUsingImpersonateToken } = await import("./impersonate");
    const req = {
      query: { auth_token: "test-token", lang_temp: "en" },
      protocol: "https",
      headers: { host: "lite4b.cocalc.ai" },
    };
    const res = { send: jest.fn() };

    await signInUsingImpersonateToken({ req, res });

    expect(queryMock).toHaveBeenCalledWith(
      "SELECT account_id FROM auth_tokens WHERE auth_token=$1 AND expire > NOW()",
      ["test-token"],
    );
    expect(getClusterAccountByIdMock).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(issueHomeBayRetryTokenMock).toHaveBeenCalledWith({
      account_id: "11111111-1111-1111-1111-111111111111",
      home_bay_id: "bay-2",
      purpose: "impersonate",
    });
    expect(getBayPublicOriginForRequestMock).toHaveBeenCalledWith(req, "bay-2");
    expect(setSignInCookiesMock).not.toHaveBeenCalled();
    expect(clientSideRedirectMock).toHaveBeenCalledWith({
      res,
      target:
        "https://bay-2-lite4b.cocalc.ai/auth/impersonate?retry_token=retry-token&lang_temp=en",
    });
  });

  it("sets cookies locally when redeeming an impersonation retry token", async () => {
    process.env.COCALC_BAY_ID = "bay-2";
    getClusterAccountByIdMock = jest.fn(async () => ({
      account_id: "11111111-1111-1111-1111-111111111111",
      home_bay_id: "bay-2",
    }));
    getBayPublicOriginForRequestMock = jest.fn(
      async () => "https://bay-2-lite4b.cocalc.ai",
    );
    verifyHomeBayRetryTokenMock = jest.fn(() => ({
      account_id: "11111111-1111-1111-1111-111111111111",
      home_bay_id: "bay-2",
      purpose: "impersonate",
    }));
    const { signInUsingImpersonateToken } = await import("./impersonate");
    const req = {
      query: { retry_token: "retry-token", lang_temp: "en" },
      protocol: "https",
      headers: { host: "bay-2-lite4b.cocalc.ai" },
    };
    const res = { send: jest.fn() };

    await signInUsingImpersonateToken({ req, res });

    expect(queryMock).not.toHaveBeenCalled();
    expect(verifyHomeBayRetryTokenMock).toHaveBeenCalledWith({
      token: "retry-token",
      home_bay_id: "bay-2",
      purpose: "impersonate",
    });
    expect(setSignInCookiesMock).toHaveBeenCalledWith({
      req,
      res,
      account_id: "11111111-1111-1111-1111-111111111111",
      maxAge: 12 * 3600 * 1000,
    });
    expect(clientSideRedirectMock).toHaveBeenCalledWith({
      res,
      target: "https://lite4b.cocalc.ai/app?lang_temp=en",
    });
  });
});
