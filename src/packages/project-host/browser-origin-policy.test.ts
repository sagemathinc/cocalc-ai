import {
  ambientCookieRejection,
  corsOrigin,
  isAllowedBrowserOrigin,
  normalizeBrowserOrigin,
  setHubBrowserOrigins,
} from "./browser-origin-policy";

describe("project-host browser origin policy", () => {
  const saved = {
    site: process.env.COCALC_SITE_URL,
    extra: process.env.COCALC_PROJECT_HOST_ALLOWED_ORIGINS,
  };
  beforeEach(() => {
    process.env.COCALC_SITE_URL = "https://cocalc.example/base";
    delete process.env.COCALC_PROJECT_HOST_ALLOWED_ORIGINS;
    setHubBrowserOrigins([]);
  });
  afterAll(() => {
    for (const [name, value] of [
      ["COCALC_SITE_URL", saved.site],
      ["COCALC_PROJECT_HOST_ALLOWED_ORIGINS", saved.extra],
    ] as const) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    setHubBrowserOrigins([]);
  });

  const req = (headers: Record<string, string> = {}) => ({
    headers: { host: "host-1.cocalc.example:443", ...headers },
  });

  it("normalizes origins and rejects opaque or non-web ones", () => {
    expect(normalizeBrowserOrigin("HTTPS://CoCalc.Example/x")).toBe(
      "https://cocalc.example",
    );
    expect(normalizeBrowserOrigin("null")).toBeUndefined();
    expect(normalizeBrowserOrigin("file:///etc")).toBeUndefined();
    expect(normalizeBrowserOrigin("garbage")).toBeUndefined();
  });

  it("allows the site, hub-listed bays, configured extras and the request host", () => {
    setHubBrowserOrigins(["https://bay-1-cocalc.example", "bogus"]);
    process.env.COCALC_PROJECT_HOST_ALLOWED_ORIGINS =
      " http://localhost:5173 ,";
    for (const origin of [
      "https://cocalc.example",
      "https://bay-1-cocalc.example",
      "http://localhost:5173",
      "https://host-1.cocalc.example",
    ]) {
      expect(isAllowedBrowserOrigin(origin, req())).toBe(true);
    }
    for (const origin of [
      "https://evil.example",
      "https://cocalc.example.evil.example",
      "https://evil-cocalc.example",
      "http://localhost:5174",
      "null",
      "",
    ]) {
      expect(isAllowedBrowserOrigin(origin, req())).toBe(false);
    }
  });

  it("reflects CORS only for allowed origins", () => {
    expect(corsOrigin(req({ origin: "https://cocalc.example" }))).toBe(
      "https://cocalc.example",
    );
    expect(corsOrigin(req({ origin: "https://evil.example" }))).toBeUndefined();
    expect(corsOrigin(req())).toBeUndefined();
  });

  it("refuses cross-site subresources but not navigations", () => {
    expect(
      ambientCookieRejection(
        req({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" }),
      ),
    ).toBe("cross-site subresource");
    expect(
      ambientCookieRejection(
        req({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }),
      ),
    ).toBeUndefined();
    expect(
      ambientCookieRejection(
        req({ "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" }),
      ),
    ).toBeUndefined();
    expect(
      ambientCookieRejection(req({ origin: "https://evil.example" })),
    ).toBe("origin not allowed");
  });
});
