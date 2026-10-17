import {
  assertCookieOrigin,
  clearAllowedOriginCacheForTests,
  cookieOriginRejection,
  parseOrigin,
} from "./browser-origin";

const isAllowedMock = jest.fn(async (origin: string) =>
  ["https://cocalc.example", "https://bay-1-cocalc.example"].includes(origin),
);
jest.mock("@cocalc/server/bay-public-origin", () => ({
  isAllowedBrowserOrigin: (origin: string) => isAllowedMock(origin),
}));

describe("hub conat cookie origin policy", () => {
  const savedMode = process.env.COCALC_CONAT_ORIGIN_POLICY;
  beforeEach(() => {
    clearAllowedOriginCacheForTests();
    isAllowedMock.mockClear();
    delete process.env.COCALC_CONAT_ORIGIN_POLICY;
  });
  afterAll(() => {
    if (savedMode == null) delete process.env.COCALC_CONAT_ORIGIN_POLICY;
    else process.env.COCALC_CONAT_ORIGIN_POLICY = savedMode;
  });

  it("accepts only serialized http(s) origins", () => {
    expect(parseOrigin("https://cocalc.example")).toBe(
      "https://cocalc.example",
    );
    for (const bad of ["null", "", "https://cocalc.example/", "file:///x"]) {
      expect(parseOrigin(bad)).toBeUndefined();
    }
  });

  it("requires an approved Origin for remember_me", async () => {
    expect(
      await cookieOriginRejection(
        { origin: "https://cocalc.example" },
        "remember-me",
      ),
    ).toBeUndefined();
    expect(
      await cookieOriginRejection(
        { origin: "https://bay-1-cocalc.example" },
        "remember-me",
      ),
    ).toBeUndefined();
    expect(
      await cookieOriginRejection(
        { origin: "https://evil.example" },
        "remember-me",
      ),
    ).toBe("origin not allowed");
    expect(await cookieOriginRejection({ origin: "null" }, "remember-me")).toBe(
      "invalid or opaque origin",
    );
    expect(await cookieOriginRejection({}, "remember-me")).toBe("no origin");
  });

  it.each(["api-key-cookie", "project-secret-cookie"] as const)(
    "lets non-browser %s clients without Origin through, but checks an Origin",
    async (credential) => {
      expect(await cookieOriginRejection({}, credential)).toBeUndefined();
      expect(
        await cookieOriginRejection(
          { origin: "https://evil.example" },
          credential,
        ),
      ).toBe("origin not allowed");
      expect(
        await cookieOriginRejection(
          { origin: "https://cocalc.example" },
          credential,
        ),
      ).toBeUndefined();
    },
  );

  it("caches the approved-origin lookup", async () => {
    const headers = {
      origin: "https://cocalc.example",
      host: "cocalc.example",
    };
    await cookieOriginRejection(headers, "remember-me");
    await cookieOriginRejection(headers, "remember-me");
    expect(isAllowedMock).toHaveBeenCalledTimes(1);
  });

  it("only logs by default (report), refuses in enforce, does nothing when off", async () => {
    const foreign = { origin: "https://evil.example" };
    await expect(
      assertCookieOrigin(foreign, "remember-me"),
    ).resolves.toBeUndefined();
    process.env.COCALC_CONAT_ORIGIN_POLICY = "enforce";
    await expect(assertCookieOrigin(foreign, "remember-me")).rejects.toThrow(
      "cross-site connection refused",
    );
    await expect(
      assertCookieOrigin({ origin: "https://cocalc.example" }, "remember-me"),
    ).resolves.toBeUndefined();
    process.env.COCALC_CONAT_ORIGIN_POLICY = "off";
    await expect(
      assertCookieOrigin(foreign, "remember-me"),
    ).resolves.toBeUndefined();
  });

  it("fails closed in enforce mode when the lookup itself fails", async () => {
    process.env.COCALC_CONAT_ORIGIN_POLICY = "enforce";
    isAllowedMock.mockRejectedValueOnce(new Error("db down"));
    await expect(
      assertCookieOrigin(
        { origin: "https://cocalc.example", host: "x" },
        "remember-me",
      ),
    ).rejects.toThrow("unable to verify connection origin");
  });
});
