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
  getSiteBrowserOrigins: async () => {
    const site = await siteMock();
    return site ? [site] : [];
  },
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
    const forged = [
      { origin: "https://evil.example", host: "evil.example" },
      {
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    ];
    for (const headers of forged) {
      expect(await cookieOriginRejection(headers)).toBe("origin not allowed");
    }
    // With no configured site the policy is "not configured" (never
    // enforced, see the top of browser-origin.ts); the Host still approves
    // nothing.
    for (const headers of forged) {
      resetApprovedOriginsForTests();
      siteMock.mockResolvedValueOnce(undefined as any);
      await expect(cookieOriginRejection(headers)).rejects.toThrow(
        "no approved origins are configured",
      );
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

  it("runs one lookup at a time, even when callers time out", async () => {
    const hang = jest.fn(() => new Promise<Set<string>>(() => {}));
    for (let k = 0; k < 3; k++) {
      await expect(
        approvedOrigins({ load: hang, timeoutMs: 5 }),
      ).rejects.toThrow();
    }
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it("fails fast during the cooldown even while a timed-out lookup still runs", async () => {
    const hang = jest.fn(() => new Promise<Set<string>>(() => {}));
    await expect(approvedOrigins({ load: hang, timeoutMs: 5 })).rejects.toThrow(
      "timed out",
    );
    const started = Date.now();
    await expect(
      approvedOrigins({ load: hang, timeoutMs: 1000 }),
    ).rejects.toThrow("recently failed");
    expect(Date.now() - started).toBeLessThan(500);
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it("does not extend the cooldown by turning callers away", async () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "setTimeout"],
    });
    try {
      jest.setSystemTime(new Date("2026-10-17T00:00:00Z"));
      const fail = jest.fn(async () => {
        throw new Error("db down");
      });
      await expect(approvedOrigins({ load: fail })).rejects.toThrow("db down");
      for (const t of ["00:00:03", "00:00:06", "00:00:09"]) {
        jest.setSystemTime(new Date(`2026-10-17T${t}Z`));
        await expect(approvedOrigins({ load: fail })).rejects.toThrow(
          "recently failed",
        );
      }
      jest.setSystemTime(new Date("2026-10-17T00:00:11Z"));
      const ok = jest.fn(async () => new Set(["https://cocalc.example"]));
      await expect(approvedOrigins({ load: ok })).resolves.toEqual(
        new Set(["https://cocalc.example"]),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("ignores a late result from an abandoned lookup", async () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "setTimeout"],
    });
    try {
      jest.setSystemTime(new Date("2026-10-17T00:00:00Z"));
      let finishOld: (s: Set<string>) => void = () => {};
      const old = () =>
        new Promise<Set<string>>((resolve) => {
          finishOld = resolve;
        });
      await expect(
        approvedOrigins({ load: old, timeoutMs: 5 }),
      ).rejects.toThrow();
      // After a minute the hung lookup is abandoned and a new one succeeds.
      jest.setSystemTime(new Date("2026-10-17T00:01:30Z"));
      await approvedOrigins({
        load: async () => new Set(["https://new.example"]),
      });
      finishOld(new Set(["https://removed.example"]));
      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        approvedOrigins({ load: async () => new Set(["https://x.example"]) }),
      ).resolves.toEqual(new Set(["https://new.example"]));
    } finally {
      jest.useRealTimers();
    }
  });

  it("recovers after the cooldown once a failed lookup has finished", async () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "setTimeout"],
    });
    try {
      jest.setSystemTime(new Date("2026-10-17T00:00:00Z"));
      const fail = jest.fn(async () => {
        throw new Error("db down");
      });
      await expect(approvedOrigins({ load: fail })).rejects.toThrow("db down");
      // Inside the cooldown: fail fast, no new lookup.
      const ok = jest.fn(async () => new Set(["https://cocalc.example"]));
      await expect(approvedOrigins({ load: ok })).rejects.toThrow(
        "recently failed",
      );
      expect(ok).not.toHaveBeenCalled();
      // After the cooldown a new lookup runs.
      jest.setSystemTime(new Date("2026-10-17T00:00:11Z"));
      await expect(approvedOrigins({ load: ok })).resolves.toEqual(
        new Set(["https://cocalc.example"]),
      );
      expect(ok).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("abandons a lookup that is still hanging after a minute", async () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "setTimeout"],
    });
    try {
      jest.setSystemTime(new Date("2026-10-17T00:00:00Z"));
      const hang = jest.fn(() => new Promise<Set<string>>(() => {}));
      await expect(
        approvedOrigins({ load: hang, timeoutMs: 5 }),
      ).rejects.toThrow();
      jest.setSystemTime(new Date("2026-10-17T00:01:30Z"));
      const ok = jest.fn(async () => new Set(["https://cocalc.example"]));
      await expect(approvedOrigins({ load: ok })).resolves.toEqual(
        new Set(["https://cocalc.example"]),
      );
    } finally {
      jest.useRealTimers();
    }
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
      // Refreshes keep failing for over 10 minutes: the last list is still
      // used (refusing every browser would be worse), and a refresh is tried.
      jest.setSystemTime(new Date("2026-10-17T00:11:00Z"));
      resetPendingForTests();
      const failing = jest.fn(async (): Promise<Set<string>> => {
        throw Error("database unavailable");
      });
      await expect(approvedOrigins({ load: failing })).resolves.toEqual(
        new Set(["https://old.example"]),
      );
      expect(failing).toHaveBeenCalledTimes(1);
      // Once a refresh succeeds, the new list replaces it.
      await Promise.resolve();
      resetPendingForTests();
      const fresh = jest.fn(async () => new Set(["https://new.example"]));
      await approvedOrigins({ load: fresh });
      await new Promise((resolve) => setImmediate(resolve));
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

  // The server's own state must never lock every browser out (cf. a
  // respawned process without the configuration, cocalc-ai #1136).
  describe("never a lockout from the server's own state, even in enforce", () => {
    const browsers = [
      { origin: "https://cocalc.example" },
      { origin: "https://evil.example" },
    ];
    beforeEach(() => {
      process.env.COCALC_CONAT_ORIGIN_POLICY = "enforce";
    });

    it("a hanging lookup (bounded) lets connections through", async () => {
      const hang = () => new Promise<Set<string>>(() => {});
      const approved = () => approvedOrigins({ load: hang, timeoutMs: 20 });
      for (const browser of browsers) {
        await expect(
          assertCookieOrigin(browser, "remember-me", approved),
        ).resolves.toBeUndefined();
      }
    });

    it("a process that can't read the configuration lets connections through", async () => {
      siteMock.mockRejectedValueOnce(Error("no database configured"));
      for (const browser of browsers) {
        await expect(
          assertCookieOrigin(browser, "remember-me"),
        ).resolves.toBeUndefined();
      }
    });

    it("an empty configuration lets connections through", async () => {
      siteMock.mockResolvedValueOnce("");
      baysMock.mockResolvedValueOnce({});
      for (const browser of browsers) {
        await expect(
          assertCookieOrigin(browser, "remember-me"),
        ).resolves.toBeUndefined();
      }
    });

    it("but a known, nonempty list is enforced", async () => {
      await expect(
        assertCookieOrigin(browsers[1], "remember-me"),
      ).rejects.toThrow("cross-site connection refused");
      await expect(
        assertCookieOrigin(browsers[0], "remember-me"),
      ).resolves.toBeUndefined();
    });
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
