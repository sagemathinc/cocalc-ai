import {
  ambientCookieRejection,
  checkAmbientCookieRequest,
  classifyProjectRoute,
  corsOrigin,
  parseOrigin,
  resetHubBrowserOriginsForTests,
  setHubBrowserOrigins,
} from "./browser-origin-policy";

const project_id = "00000000-1000-4000-8000-000000000000";

describe("project-host browser origin policy", () => {
  const saved = {
    site: process.env.COCALC_SITE_URL,
    extra: process.env.COCALC_PROJECT_HOST_ALLOWED_ORIGINS,
    mode: process.env.COCALC_PROJECT_HOST_ORIGIN_POLICY,
  };
  beforeEach(() => {
    process.env.COCALC_SITE_URL = "https://cocalc.example/base";
    delete process.env.COCALC_PROJECT_HOST_ALLOWED_ORIGINS;
    delete process.env.COCALC_PROJECT_HOST_ORIGIN_POLICY;
    resetHubBrowserOriginsForTests();
  });
  afterAll(() => {
    for (const [name, value] of [
      ["COCALC_SITE_URL", saved.site],
      ["COCALC_PROJECT_HOST_ALLOWED_ORIGINS", saved.extra],
      ["COCALC_PROJECT_HOST_ORIGIN_POLICY", saved.mode],
    ] as const) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    resetHubBrowserOriginsForTests();
  });

  const req = (headers: Record<string, string> = {}, method = "GET") => ({
    method,
    url: `/${project_id}/files/a.txt`,
    headers: { host: "host-1.cocalc.example", ...headers },
  });

  it("accepts only serialized http(s) origins", () => {
    expect(parseOrigin("https://CoCalc.Example")).toBe(
      "https://cocalc.example",
    );
    expect(parseOrigin("https://cocalc.example:8443")).toBe(
      "https://cocalc.example:8443",
    );
    for (const bad of [
      "null",
      "",
      "garbage",
      "file:///etc",
      "https://cocalc.example/",
      "https://cocalc.example/x",
      "https://user@cocalc.example",
    ]) {
      expect(parseOrigin(bad)).toBeUndefined();
    }
  });

  it("classifies routes", () => {
    expect(classifyProjectRoute(req(), project_id)).toBe("file");
    expect(
      classifyProjectRoute(
        { ...req(), url: `/${project_id}/upload` },
        project_id,
      ),
    ).toBe("upload");
    expect(
      classifyProjectRoute(
        { ...req(), url: `/${project_id}/apps/x/` },
        project_id,
      ),
    ).toBe("app");
  });

  describe("with an Origin header", () => {
    it("allows the site, hub-listed bays and configured extras", () => {
      setHubBrowserOrigins(["https://bay-1-cocalc.example", "bogus"]);
      process.env.COCALC_PROJECT_HOST_ALLOWED_ORIGINS =
        " http://localhost:5173 ,";
      for (const origin of [
        "https://cocalc.example",
        "https://bay-1-cocalc.example",
        "http://localhost:5173",
      ]) {
        expect(ambientCookieRejection(req({ origin }), "file")).toBeUndefined();
      }
    });

    it("refuses everything else", () => {
      for (const origin of [
        "https://evil.example",
        "https://cocalc.example.evil.example",
        "https://evil-cocalc.example",
        "http://cocalc.example",
        "https://cocalc.example:8443",
        "null",
      ]) {
        expect(ambientCookieRejection(req({ origin }), "file")).toBeDefined();
      }
    });

    it("keeps the last known-good hub origins when a refresh is empty", () => {
      setHubBrowserOrigins(["https://bay-1-cocalc.example"]);
      setHubBrowserOrigins([]);
      expect(
        ambientCookieRejection(
          req({ origin: "https://bay-1-cocalc.example" }),
          "file",
        ),
      ).toBeUndefined();
    });

    it("approves the host's own origin only for app routes", () => {
      const own = req({ origin: "https://host-1.cocalc.example" });
      expect(ambientCookieRejection(own, "app")).toBeUndefined();
      for (const route of ["file", "upload", "bootstrap", "conat"] as const) {
        expect(ambientCookieRejection(own, route)).toBe("origin not allowed");
      }
      // Same host but another scheme or port is not the same origin.
      expect(
        ambientCookieRejection(
          req({ origin: "http://host-1.cocalc.example" }),
          "app",
        ),
      ).toBeDefined();
      expect(
        ambientCookieRejection(
          req({ origin: "https://host-1.cocalc.example:8443" }),
          "app",
        ),
      ).toBeDefined();
      // A forwarded host header does not make an origin "own".
      expect(
        ambientCookieRejection(
          req({
            origin: "https://evil.example",
            "x-forwarded-host": "evil.example",
          }),
          "app",
        ),
      ).toBeDefined();
    });
  });

  describe("without an Origin header", () => {
    it("refuses unsafe methods", () => {
      expect(ambientCookieRejection(req({}, "POST"), "upload")).toBe(
        "no origin",
      );
    });

    it("allows requests without fetch metadata and user-typed URLs", () => {
      expect(ambientCookieRejection(req(), "file")).toBeUndefined();
      expect(
        ambientCookieRejection(req({ "sec-fetch-site": "none" }), "file"),
      ).toBeUndefined();
    });

    it("allows the app's own subresources, iframes and links via Referer", () => {
      for (const dest of ["image", "iframe", "document"]) {
        expect(
          ambientCookieRejection(
            req({
              "sec-fetch-site": "same-site",
              "sec-fetch-dest": dest,
              referer: "https://cocalc.example/",
            }),
            "file",
          ),
        ).toBeUndefined();
      }
    });

    it.each([
      ["a same-site sibling", "same-site", "https://sibling.cocalc.example/"],
      ["a foreign site", "cross-site", "https://evil.example/page"],
      ["a page without a referrer", "cross-site", ""],
      [
        "the host's own pages",
        "same-origin",
        "https://host-1.cocalc.example/x",
      ],
    ])("refuses file subresources from %s", (_, site, referer) => {
      expect(
        ambientCookieRejection(
          req({
            "sec-fetch-site": site,
            "sec-fetch-mode": "no-cors",
            "sec-fetch-dest": "script",
            ...(referer ? { referer } : {}),
          }),
          "file",
        ),
      ).toBe("not from an approved page");
    });

    it("allows same-origin subresources on app routes", () => {
      expect(
        ambientCookieRejection(
          req({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "script" }),
          "app",
        ),
      ).toBeUndefined();
    });

    it("allows only a user-activated top-level explicit download", () => {
      const download = (headers: Record<string, string>, url: string) =>
        ambientCookieRejection(
          {
            ...req({
              "sec-fetch-site": "cross-site",
              "sec-fetch-mode": "navigate",
              "sec-fetch-dest": "document",
              "sec-fetch-user": "?1",
              ...headers,
            }),
            url,
          },
          "file",
        );
      const file = `/${project_id}/files/a.html`;
      expect(download({}, `${file}?download=1`)).toBeUndefined();
      expect(download({}, file)).toBeDefined();
      expect(
        download({ "sec-fetch-dest": "iframe" }, `${file}?download=1`),
      ).toBeDefined();
      expect(
        download({ "sec-fetch-user": "" }, `${file}?download=1`),
      ).toBeDefined();
    });

    it("allows websockets without an origin (non-browser clients)", () => {
      expect(ambientCookieRejection(req(), "conat")).toBeUndefined();
    });
  });

  describe("modes", () => {
    const foreign = () => req({ origin: "https://evil.example" });

    it("enforce refuses and sends no CORS header", () => {
      expect(checkAmbientCookieRequest(foreign(), "file")).toBe(false);
      expect(corsOrigin(foreign())).toBeUndefined();
      expect(corsOrigin(req({ origin: "https://cocalc.example" }))).toBe(
        "https://cocalc.example",
      );
    });

    it.each(["report", "off"])("%s keeps the old behavior", (mode) => {
      process.env.COCALC_PROJECT_HOST_ORIGIN_POLICY = mode;
      expect(checkAmbientCookieRequest(foreign(), "file")).toBe(true);
      expect(corsOrigin(foreign())).toBe("https://evil.example");
    });
  });
});
