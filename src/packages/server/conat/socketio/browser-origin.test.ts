import {
  approvedOrigins,
  assertCookieOrigin,
  cookieOriginRejection,
  parseOrigin,
  resetApprovedOriginsForTests,
  resetPendingForTests,
} from "./browser-origin";

const siteMock = jest.fn(async () => "https://cocalc.example");
const baysMock = jest.fn(async () => ({
  "bay-1": "https://bay-1-cocalc.example",
}));
jest.mock("@cocalc/server/bay-public-origin", () => ({
  getSitePublicOrigin: () => siteMock(),
  getClusterBayPublicOrigins: (opts) => baysMock(opts),
}));

describe("hub conat cookie origin policy", () => {
  const saved = {
    mode: process.env.COCALC_CONAT_ORIGIN_POLICY,
    extra: process.env.COCALC_CONAT_ALLOWED_ORIGINS,
  };
  beforeEach(() => {
    resetApprovedOriginsForTests();
    siteMock.mockClear();
    baysMock.mockClear();
    delete process.env.COCALC_CONAT_ORIGIN_POLICY;
    delete process.env.COCALC_CONAT_ALLOWED_ORIGINS;
  });
  afterAll(() => {
    for (const [name, value] of [
      ["COCALC_CONAT_ORIGIN_POLICY", saved.mode],
      ["COCALC_CONAT_ALLOWED_ORIGINS", saved.extra],
    ] as const) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("accepts only serialized http(s) origins", () => {
    expect(parseOrigin("https://cocalc.example")).toBe(
      "https://cocalc.example",
    );
    for (const bad of [
      "null",
      "",
      "https://cocalc.example/",
      "file:///x",
      "https://user@cocalc.example",
    ]) {
      expect(parseOrigin(bad)).toBeUndefined();
    }
  });

  it("approves only configured origins: site, bays and the explicit list", async () => {
    process.env.COCALC_CONAT_ALLOWED_ORIGINS = "http://localhost:5173, junk";
    for (const origin of [
      "https://cocalc.example",
      "https://bay-1-cocalc.example",
      "http://localhost:5173",
    ]) {
      expect(await cookieOriginRejection({ origin })).toBeUndefined();
    }
    for (const origin of [
      "https://evil.example",
      "https://cocalc.example.evil.example",
      "http://cocalc.example",
      "https://cocalc.example:8443",
      "https://cocalc.example.",
    ]) {
      expect(await cookieOriginRejection({ origin })).toBeDefined();
    }
    expect(baysMock).toHaveBeenCalledWith({ strict: true });
  });

  it("never approves an origin because the request's Host names it", async () => {
    // Even with no configured site at all.
    siteMock.mockResolvedValueOnce(undefined as any);
    for (const headers of [
      { origin: "https://evil.example", host: "evil.example" },
      {
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    ]) {
      expect(await cookieOriginRejection(headers)).toBe("origin not allowed");
    }
  });

  it("lets clients without an Origin (CLI, mobile, services) through", async () => {
    expect(await cookieOriginRejection({})).toBeUndefined();
    process.env.COCALC_CONAT_ORIGIN_POLICY = "enforce";
    for (const credential of [
      "remember-me",
      "api-key-cookie",
      "project-secret-cookie",
    ] as const) {
      await expect(assertCookieOrigin({}, credential)).resolves.toBeUndefined();
    }
  });

  it("abandons a timed-out lookup so the next one can recover", async () => {
    const hang = jest.fn(() => new Promise<Set<string>>(() => {}));
    await expect(
      approvedOrigins({ load: hang, timeoutMs: 10 }),
    ).rejects.toThrow("timed out");
    const ok = jest.fn(async () => new Set(["https://cocalc.example"]));
    await expect(approvedOrigins({ load: ok, timeoutMs: 10 })).resolves.toEqual(
      new Set(["https://cocalc.example"]),
    );
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("serves a stale list without waiting and refreshes it in the background", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      jest.setSystemTime(new Date("2026-10-17T00:00:00Z"));
      await approvedOrigins({
        load: async () => new Set(["https://old.example"]),
      });
      // 2 minutes later the list is stale but usable.
      jest.setSystemTime(new Date("2026-10-17T00:02:00Z"));
      const hang = jest.fn(() => new Promise<Set<string>>(() => {}));
      await expect(
        approvedOrigins({ load: hang, timeoutMs: 50 }),
      ).resolves.toEqual(new Set(["https://old.example"]));
      expect(hang).toHaveBeenCalledTimes(1);
      // A removed origin is not approved forever: after 10 minutes the old
      // list is no longer used.
      jest.setSystemTime(new Date("2026-10-17T00:11:00Z"));
      resetPendingForTests();
      const fresh = jest.fn(async () => new Set(["https://new.example"]));
      await expect(approvedOrigins({ load: fresh })).resolves.toEqual(
        new Set(["https://new.example"]),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("caches the list and keeps the last complete one when a lookup fails", async () => {
    const load = jest.fn(async () => new Set(["https://cocalc.example"]));
    await approvedOrigins({ load });
    await approvedOrigins({ load });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("bounds a hanging lookup: refuses in enforce, only logs in report", async () => {
    const hang = () => new Promise<Set<string>>(() => {});
    const approved = () => approvedOrigins({ load: hang, timeoutMs: 20 });
    const browser = { origin: "https://cocalc.example" };
    await expect(
      assertCookieOrigin(browser, "remember-me", approved),
    ).resolves.toBeUndefined();
    resetApprovedOriginsForTests();
    process.env.COCALC_CONAT_ORIGIN_POLICY = "enforce";
    await expect(
      assertCookieOrigin(browser, "remember-me", approved),
    ).rejects.toThrow("unable to verify connection origin");
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
});
