import {
  getRememberMeCookieNamesForRequest,
  getRememberMeCookieValuesFromHeader,
} from "./remember-me";

describe("auth/remember-me cookie parsing", () => {
  const prevEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it("accepts the site-namespaced shared remember_me cookie for bay sibling hosts", () => {
    process.env.COCALC_BAY_ID = "bay-2";
    const cookieNames = getRememberMeCookieNamesForRequest({
      headers: {
        host: "bay-2-alpha.cocalc.ai",
        "x-forwarded-proto": "https",
      },
      protocol: "https",
      secure: true,
    } as any);

    expect(cookieNames).toEqual(["remember_me", "alpha_cocalc_ai_remember_me"]);
    expect(
      getRememberMeCookieValuesFromHeader(
        "lite4b_cocalc_ai_remember_me=wrong; alpha_cocalc_ai_remember_me=right",
        cookieNames,
      ),
    ).toEqual(["right"]);
  });
});
