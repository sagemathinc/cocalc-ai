import {
  ambientCookieRejection,
  checkAmbientCookieRequest,
  classifyProjectRoute,
  corsOrigin,
  parseOrigin,
  persistHubBrowserOrigins,
  persistedBrowserOrigins,
  resetHubBrowserOriginsForTests,
  setHubBrowserOrigins,
} from "./browser-origin-policy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const project_id = "00000000-1000-4000-8000-000000000000";

describe("project-host browser origin policy", () => {
  const saved = {
    site: process.env.COCALC_SITE_URL,
    extra: process.env.COCALC_PROJECT_HOST_ALLOWED_ORIGINS,
    mode: process.env.COCALC_PROJECT_HOST_ORIGIN_POLICY,
    publicUrl: process.env.PROJECT_HOST_PUBLIC_URL,
  };
  beforeEach(() => {
    process.env.COCALC_SITE_URL = "https://cocalc.example/base";
    process.env.PROJECT_HOST_PUBLIC_URL = "https://host-1.cocalc.example";
    delete process.env.COCALC_PROJECT_HOST_ALLOWED_ORIGINS;
    delete process.env.COCALC_PROJECT_HOST_ORIGIN_POLICY;
    resetHubBrowserOriginsForTests();
  });
  afterAll(() => {
    for (const [name, value] of [
      ["COCALC_SITE_URL", saved.site],
      ["COCALC_PROJECT_HOST_ALLOWED_ORIGINS", saved.extra],
      ["COCALC_PROJECT_HOST_ORIGIN_POLICY", saved.mode],
      ["PROJECT_HOST_PUBLIC_URL", saved.publicUrl],
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

  // 2026-10-17: a conat router respawned by the host agent (after a crash)
  // inherits neither the app's hub origins nor its runtime COCALC_SITE_URL,
  // and refused every browser ("cross-site connection refused").
  describe("origins persisted by the app for the host's other processes", () => {
    let dir: string;
    const savedData = process.env.COCALC_DATA;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "origins-"));
      process.env.COCALC_DATA = dir;
    });
    afterEach(() => {
      if (savedData == null) delete process.env.COCALC_DATA;
      else process.env.COCALC_DATA = savedData;
      fs.rmSync(dir, { recursive: true, force: true });
      jest.restoreAllMocks();
    });
    // What a freshly spawned router process has: no hub origins in memory
    // and no COCALC_SITE_URL, only the shared data directory.
    const asRespawnedRouter = () => {
      resetHubBrowserOriginsForTests();
      delete process.env.COCALC_SITE_URL;
    };

    it("lets a respawned router accept the site and hub origins", () => {
      asRespawnedRouter();
      for (const origin of [
        "https://cocalc.example",
        "https://bay-1-cocalc.example",
      ]) {
        expect(ambientCookieRejection(req({ origin }), "conat")).toBe(
          "origin not allowed",
        );
      }
      // The app (with the hub's answer) persists them...
      persistHubBrowserOrigins({
        site_url: "https://cocalc.example/base",
        browser_origins: ["https://bay-1-cocalc.example", "bogus"],
      });
      expect(
        fs.statSync(path.join(dir, "browser-origins.json")).mode & 0o777,
      ).toBe(0o600);
      asRespawnedRouter();
      for (const origin of [
        "https://cocalc.example",
        "https://bay-1-cocalc.example",
      ]) {
        expect(
          ambientCookieRejection(req({ origin }), "conat"),
        ).toBeUndefined();
      }
      expect(
        ambientCookieRejection(
          req({ origin: "https://evil.example" }),
          "conat",
        ),
      ).toBe("origin not allowed");
      expect(persistedBrowserOrigins().site_url).toBe(
        "https://cocalc.example/base",
      );
    });

    it("keeps the last known-good file when a refresh is empty or the file breaks", () => {
      persistHubBrowserOrigins({
        site_url: "https://cocalc.example",
        browser_origins: [],
      });
      persistHubBrowserOrigins({ site_url: "", browser_origins: [] });
      asRespawnedRouter();
      expect(
        ambientCookieRejection(
          req({ origin: "https://cocalc.example" }),
          "conat",
        ),
      ).toBeUndefined();
      // A corrupt file (e.g. a partial write by another tool) keeps the value
      // already loaded.
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now + 60_000);
      fs.writeFileSync(path.join(dir, "browser-origins.json"), "{oops");
      expect(
        ambientCookieRejection(
          req({ origin: "https://cocalc.example" }),
          "conat",
        ),
      ).toBeUndefined();
    });

    it("keeps the bay origins when a refresh has the site URL but no origins", () => {
      persistHubBrowserOrigins({
        site_url: "https://cocalc.example",
        browser_origins: ["https://bay-1-cocalc.example"],
      });
      // A failed bay lookup: the hub still answers with the site URL.
      persistHubBrowserOrigins({
        site_url: "https://cocalc.example",
        browser_origins: undefined,
      });
      persistHubBrowserOrigins({
        site_url: "https://cocalc.example",
        browser_origins: [],
      });
      asRespawnedRouter();
      for (const origin of [
        "https://cocalc.example",
        "https://bay-1-cocalc.example",
      ]) {
        expect(
          ambientCookieRejection(req({ origin }), "conat"),
        ).toBeUndefined();
      }
    });

    it("picks up a newer refresh by the app", () => {
      persistHubBrowserOrigins({ site_url: "https://cocalc.example" });
      asRespawnedRouter();
      expect(persistedBrowserOrigins().origins).toEqual([
        "https://cocalc.example",
      ]);
      persistHubBrowserOrigins({
        site_url: "https://cocalc.example",
        browser_origins: ["https://bay-2-cocalc.example"],
      });
      const file = path.join(dir, "browser-origins.json");
      const later = new Date(Date.now() + 10_000);
      fs.utimesSync(file, later, later);
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      expect(
        ambientCookieRejection(
          req({ origin: "https://bay-2-cocalc.example" }),
          "conat",
        ),
      ).toBeUndefined();
    });
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

    it("approves the host's own origin for apps and file reads only", () => {
      const own = req({ origin: "https://host-1.cocalc.example" });
      expect(ambientCookieRejection(own, "app")).toBeUndefined();
      expect(ambientCookieRejection(own, "file")).toBeUndefined();
      expect(
        ambientCookieRejection(
          req({ origin: "https://host-1.cocalc.example" }, "POST"),
          "file",
        ),
      ).toBe("origin not allowed");
      for (const route of ["upload", "bootstrap", "conat"] as const) {
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

  // The exam webapp is served on the host's exam hostname and signs the
  // student in with the host session cookie set at admission; its websocket
  // was refused ("origin not allowed"), so admitted students saw "Sign in to
  // request project access".
  describe("on the host's own exam hostname", () => {
    const exam = "exam-1.cocalc.example";
    const examReq = (headers: Record<string, string> = {}, method = "GET") =>
      req({ host: exam, ...headers }, method);
    afterEach(() => {
      delete process.env.COCALC_PROJECT_CONTENT_DOMAIN;
      delete process.env.PROJECT_HOST_ID;
    });

    it("approves the exam page's own origin on every route, websockets included", () => {
      for (const route of [
        "conat",
        "file",
        "app",
        "upload",
        "bootstrap",
      ] as const) {
        expect(
          ambientCookieRejection(examReq({ origin: `https://${exam}` }), route),
        ).toBeUndefined();
      }
      expect(
        ambientCookieRejection(
          examReq({ origin: `https://${exam}` }, "POST"),
          "upload",
        ),
      ).toBeUndefined();
      expect(
        checkAmbientCookieRequest(
          examReq({ origin: `https://${exam}` }),
          "conat",
        ),
      ).toBe(true);
    });

    it("still refuses other origins there", () => {
      for (const origin of [
        "https://evil.example",
        "https://exam-2.cocalc.example", // another host's exam pages
        "https://host-1.cocalc.example",
        `http://${exam}`,
        `https://${exam}:8443`,
      ]) {
        expect(ambientCookieRejection(examReq({ origin }), "conat")).toBe(
          "origin not allowed",
        );
      }
    });

    it("gives the exam origin nothing on the canonical host or another hostname", () => {
      expect(
        ambientCookieRejection(req({ origin: `https://${exam}` }), "conat"),
      ).toBe("origin not allowed");
      expect(
        ambientCookieRejection(
          req({
            host: "exam-2.cocalc.example",
            origin: "https://exam-2.cocalc.example",
          }),
          "conat",
        ),
      ).toBe("origin not allowed");
    });

    it("works with app origins too: exam pages are on the exam hostname", () => {
      process.env.COCALC_PROJECT_CONTENT_DOMAIN = "usercontent.example";
      expect(
        ambientCookieRejection(examReq({ origin: `https://${exam}` }), "conat"),
      ).toBeUndefined();
    });

    it("without Origin: same-origin fetches only", () => {
      expect(
        ambientCookieRejection(
          examReq({
            "sec-fetch-site": "same-origin",
            "sec-fetch-dest": "empty",
          }),
          "file",
        ),
      ).toBeUndefined();
      expect(
        ambientCookieRejection(
          examReq({
            "sec-fetch-site": "cross-site",
            "sec-fetch-dest": "empty",
          }),
          "file",
        ),
      ).toBe("not from an approved page");
    });

    it("derives the exam hostname from PROJECT_HOST_ID when the public name has no host- prefix", () => {
      process.env.PROJECT_HOST_PUBLIC_URL = "https://hosts.cocalc.example";
      process.env.PROJECT_HOST_ID = "AbC";
      const r = (origin: string, host: string) =>
        ambientCookieRejection(req({ host, origin }), "conat");
      expect(
        r("https://exam-abc.cocalc.example", "exam-abc.cocalc.example"),
      ).toBeUndefined();
      delete process.env.PROJECT_HOST_ID;
      expect(
        r("https://exam-abc.cocalc.example", "exam-abc.cocalc.example"),
      ).toBe("origin not allowed");
    });
  });

  describe("with app origins (a content domain)", () => {
    afterEach(() => {
      delete process.env.COCALC_PROJECT_CONTENT_DOMAIN;
    });
    it("no page of the canonical host may use the cookie (D7)", () => {
      process.env.COCALC_PROJECT_CONTENT_DOMAIN = "usercontent.example";
      const own = req({ origin: "https://host-1.cocalc.example" });
      expect(ambientCookieRejection(own, "app")).toBe("origin not allowed");
      expect(ambientCookieRejection(own, "file")).toBe("origin not allowed");
      // Nor without Origin, as a same-origin request.
      expect(
        ambientCookieRejection(
          req({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" }),
          "file",
        ),
      ).toBeDefined();
      // The site's pages are unaffected.
      expect(
        ambientCookieRejection(
          req({ origin: "https://cocalc.example" }),
          "app",
        ),
      ).toBeUndefined();
    });
  });

  describe("without an Origin header", () => {
    it("refuses unsafe methods", () => {
      expect(ambientCookieRejection(req({}, "POST"), "upload")).toBe(
        "no origin",
      );
    });

    it("refuses requests without fetch metadata, allows user-typed URLs", () => {
      expect(ambientCookieRejection(req(), "file")).toBe("no fetch metadata");
      expect(ambientCookieRejection(req(), "app")).toBe("no fetch metadata");
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

    it("classifies nested file markers as app routes, as dispatch does", () => {
      expect(
        classifyProjectRoute(
          { ...req(), url: `/${project_id}/apps/x/${project_id}/files/a.txt` },
          project_id,
        ),
      ).toBe("app");
    });

    it("gives no own-origin allowance on any other hostname, e.g. a former private app hostname", () => {
      const other = "00000000-1000-4000-8000-0000000000aa";
      for (const target of [project_id, other]) {
        for (const [kind, route] of [
          ["apps/x/", "app"],
          ["files/a.txt", "file"],
        ] as const) {
          for (const headers of [
            { origin: "https://dev-1.app.example" },
            { "sec-fetch-site": "same-origin" },
          ]) {
            const r: any = {
              method: "GET",
              url: `/${target}/${kind}`,
              headers: { host: "dev-1.app.example", ...headers },
            };
            expect(ambientCookieRejection(r, route, target)).toBeDefined();
          }
        }
      }
    });

    it("lets an HTML preview on the host load its relative files", () => {
      for (const dest of ["image", "style", "script", "empty"]) {
        expect(
          ambientCookieRejection(
            req({
              "sec-fetch-site": "same-origin",
              "sec-fetch-dest": dest,
              referer: `https://host-1.cocalc.example/${project_id}/files/a.html`,
            }),
            "file",
          ),
        ).toBeUndefined();
      }
      // Only on the host's own public hostname.
      expect(
        ambientCookieRejection(
          {
            method: "GET",
            url: `/${project_id}/files/a.txt`,
            headers: {
              host: "other-host.example",
              "sec-fetch-site": "same-origin",
            },
          },
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

    it("allows top-level page navigations of apps and files, even without a Referer", () => {
      const navigate = (url: string, headers: Record<string, string> = {}) =>
        ambientCookieRejection(
          {
            ...req({
              "sec-fetch-site": "same-site",
              "sec-fetch-mode": "navigate",
              "sec-fetch-dest": "document",
              ...headers,
            }),
            url,
          },
          classifyProjectRoute({ url } as any, project_id),
          project_id,
        );
      // The app opens JupyterLab with window.open(url, "_blank",
      // "noopener,noreferrer"): no Origin, no Referer.
      expect(navigate(`/${project_id}/port/6002/`)).toBeUndefined();
      expect(
        navigate(`/${project_id}/port/6002/lab`, {
          "sec-fetch-site": "cross-site",
        }),
      ).toBeUndefined();
      expect(navigate(`/${project_id}/files/a.pdf`)).toBeUndefined();
      // Frames, fetches and subresources from other pages stay refused.
      for (const dest of ["iframe", "frame", "empty", "script", "image"]) {
        expect(
          navigate(`/${project_id}/port/6002/`, {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode":
              dest == "iframe" || dest == "frame" ? "navigate" : "no-cors",
            "sec-fetch-dest": dest,
          }),
        ).toBe("not from an approved page");
      }
      // Unsafe methods still need an approved Origin.
      expect(
        ambientCookieRejection(
          {
            ...req(
              { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
              "POST",
            ),
            url: `/${project_id}/port/6002/`,
          },
          "app",
          project_id,
        ),
      ).toBe("no origin");
    });

    it("binds top-level navigations to the serving host like the other own-origin rules", async () => {
      const other = "00000000-1000-4000-8000-0000000000aa";
      const navHeaders = {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      };
      for (const target of [project_id, other]) {
        for (const kind of ["files", "port/6002"]) {
          const r: any = {
            method: "GET",
            url: `/${target}/${kind}/x`,
            headers: { host: "dev-1.app.example", ...navHeaders },
          };
          expect(
            ambientCookieRejection(r, classifyProjectRoute(r, target), target),
          ).toBe("not from an approved page");
        }
      }
      // Any host that is not the shared host.
      expect(
        ambientCookieRejection(
          {
            method: "GET",
            url: `/${project_id}/files/a.txt`,
            headers: { host: "other-host.example", ...navHeaders },
          },
          "file",
          project_id,
        ),
      ).toBe("not from an approved page");
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
