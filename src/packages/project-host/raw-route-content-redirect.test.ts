import {
  contentViewSiteOrigin,
  isNavigationRequest,
  rawRouteContentRedirect,
} from "./raw-route-content-redirect";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SITE = "https://site.test";

function req(url: string, headers: Record<string, string> = {}, method = "GET") {
  return { url, method, headers } as any;
}

const redirect = (r: any, extra: object = {}) =>
  rawRouteContentRedirect({
    req: r,
    project_id: PROJECT,
    contentDomain: "content.test",
    siteOrigin: SITE,
    ...extra,
  });

describe("opening a non-passive file as a page", () => {
  it("goes to the content view, keeping the query but never the host token", () => {
    expect(
      redirect(
        req(`/${PROJECT}/files/dir/a%20b.html?x=1&cocalc_project_host_token=SECRET`, {
          "sec-fetch-dest": "document",
        }),
      ),
    ).toBe(`${SITE}/content-view/${PROJECT}/dir/a%20b.html?x=1`);
  });

  it.each(["a.html", "a.svg", "a.xml", "a.xhtml", "a.xsl", "a.mathml", "noext"])(
    "%s",
    (name) => {
      expect(redirect(req(`/${PROJECT}/files/${name}`))).toBe(
        `${SITE}/content-view/${PROJECT}/${name}`,
      );
    },
  );

  it.each(["document", "iframe", "frame", "embed", "object", "fencedframe", "", "future-dest"])(
    "Sec-Fetch-Dest %p is a navigation",
    (dest) => {
      const headers = dest ? { "sec-fetch-dest": dest } : {};
      expect(isNavigationRequest(req("/", headers))).toBe(true);
      expect(redirect(req(`/${PROJECT}/files/a.html`, headers))).toBeDefined();
    },
  );

  it.each(["image", "script", "style", "font", "empty", "video", "worker"])(
    "Sec-Fetch-Dest %p is a subresource, served here (sandboxed)",
    (dest) => {
      expect(
        redirect(req(`/${PROJECT}/files/a.html`, { "sec-fetch-dest": dest })),
      ).toBeUndefined();
    },
  );
});

describe("served here as before", () => {
  it("passive files", () => {
    for (const name of ["a.png", "a.pdf", "a.txt", "a.mp4", "a.json", "a.csv"]) {
      expect(redirect(req(`/${PROJECT}/files/${name}`))).toBeUndefined();
    }
  });

  it("a passive path can't be renamed into an active type", () => {
    expect(
      redirect(req(`/${PROJECT}/files/a.png?downloadFilename=x.html`)),
    ).toBeUndefined();
  });

  it("explicit downloads (attachments)", () => {
    expect(redirect(req(`/${PROJECT}/files/a.html?download`))).toBeUndefined();
  });

  it("clients with an Authorization header (CLI, agents, API keys)", () => {
    expect(
      redirect(req(`/${PROJECT}/files/a.html`, { authorization: "Bearer x" })),
    ).toBeUndefined();
  });

  it("HEAD", () => {
    expect(redirect(req(`/${PROJECT}/files/a.html`, {}, "HEAD"))).toBeUndefined();
  });

  it("public directory shares (an opaque origin instead)", () => {
    expect(redirect(req(`/${PROJECT}/files/a.html`), { share: true })).toBeUndefined();
  });

  it("sites without content origins, or without a site to send to", () => {
    expect(redirect(req(`/${PROJECT}/files/a.html`), { contentDomain: undefined })).toBeUndefined();
    expect(redirect(req(`/${PROJECT}/files/a.html`), { siteOrigin: undefined })).toBeUndefined();
  });

  it("other routes", () => {
    expect(redirect(req(`/${PROJECT}/server/8000/a.html`))).toBeUndefined();
    expect(redirect(req(`/other/files/a.html`))).toBeUndefined();
  });
});

describe("which site's content view", () => {
  const approvedOrigins = new Set(["https://a.test", "https://b.test"]);
  it("the approved site the user came from", () => {
    expect(
      contentViewSiteOrigin({
        req: req("/", { referer: "https://b.test/projects/x" }),
        approvedOrigins,
        siteUrl: "https://a.test/",
      }),
    ).toBe("https://b.test");
  });
  it("else the configured site", () => {
    for (const referer of ["https://evil.test/", "javascript:alert(1)", ""]) {
      expect(
        contentViewSiteOrigin({
          req: req("/", referer ? { referer } : {}),
          approvedOrigins,
          siteUrl: "https://a.test/base",
        }),
      ).toBe("https://a.test");
    }
  });
});
