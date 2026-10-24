/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { hostAppRouteRedirect } from "./host-app-route-redirect";

const P = "11111111-1111-4111-8111-111111111111";
const SITE = "https://cocalc.example";
const DOMAIN = "usercontent.example";

const req = (
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
) => ({
  url,
  method,
  headers,
});
const decide = (
  r: ReturnType<typeof req>,
  contentDomain: string | undefined = DOMAIN,
) =>
  hostAppRouteRedirect({
    req: r,
    project_id: P,
    contentDomain,
    siteOrigin: SITE,
  });

describe("D7: app routes are never pages on the host origin", () => {
  it("sends every document load of an app route to the site's /app-open, without the token", () => {
    for (const dest of ["document", "iframe", "frame", "object", "embed", ""]) {
      const headers: Record<string, string> = { cookie: "x=1" };
      if (dest) headers["sec-fetch-dest"] = dest;
      expect(
        decide(
          req(`/${P}/port/8000/a?b=1&cocalc_project_host_token=T`, headers),
        ),
      ).toEqual({
        redirect: `${SITE}/app-open/${P}/port/8000/a?b=1&cocalc_app_redirect=1`,
      });
    }
  });

  it("whatever authenticates it: cookie, query token or scoped key", () => {
    expect(
      decide(
        req(`/${P}/proxy/3000/`, {
          "x-cocalc-project-host-api-key": "k",
          "sec-fetch-dest": "document",
        }),
      ),
    ).toMatchObject({ redirect: expect.stringContaining("/app-open/") });
  });

  it("serves subresources, XHR, files, and Authorization requests as before", () => {
    expect(
      decide(req(`/${P}/port/8000/x.js`, { "sec-fetch-dest": "script" })),
    ).toBeUndefined();
    expect(
      decide(req(`/${P}/port/8000/api`, { "sec-fetch-dest": "empty" })),
    ).toBeUndefined();
    expect(
      decide(req(`/${P}/files/a.png`, { "sec-fetch-dest": "document" })),
    ).toBeUndefined();
    expect(
      decide(
        req(`/${P}/port/8000/`, {
          authorization: "Bearer x",
          "sec-fetch-dest": "document",
        }),
      ),
    ).toBeUndefined();
  });

  it("is off without a content domain", () => {
    expect(
      decide(
        req(`/${P}/port/8000/`, { "sec-fetch-dest": "document" }),
        "",
      ),
    ).toBeUndefined();
  });

  it("refuses form posts and loops", () => {
    expect(
      decide(req(`/${P}/port/8000/`, { "sec-fetch-dest": "document" }, "POST")),
    ).toMatchObject({
      refuse: 403,
    });
    expect(
      decide(
        req(`/${P}/port/8000/?cocalc_app_redirect=1`, {
          "sec-fetch-dest": "document",
        }),
      ),
    ).toMatchObject({ refuse: 503 });
  });
});
