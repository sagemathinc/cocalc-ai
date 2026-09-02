/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  normalizePrivateAppCacheControl,
  stripLegacyPublicAppRequestMetadata,
} from "./app-proxy";

describe("private app cache control", () => {
  it("uses a private default", () => {
    expect(normalizePrivateAppCacheControl(undefined)).toBe(
      "private, max-age=60, must-revalidate",
    );
  });

  it("preserves browser caching while removing shared-cache directives", () => {
    expect(
      normalizePrivateAppCacheControl(
        "public, max-age=3600, s-maxage=600, must-revalidate",
      ),
    ).toBe("private, max-age=3600, must-revalidate");
  });

  it("does not duplicate an existing private directive", () => {
    expect(normalizePrivateAppCacheControl("private, no-store")).toBe(
      "private, no-store",
    );
  });
});

describe("retired public app request metadata", () => {
  it("strips the legacy host header and query token", () => {
    const req = {
      headers: {
        "x-cocalc-public-app-host": "demo.example.invalid",
        "x-keep-me": "yes",
      },
      url: "/project/apps/demo/?x=1&cocalc_app_token=retired&y=2",
    };

    stripLegacyPublicAppRequestMetadata(req);

    expect(req.headers).toEqual({ "x-keep-me": "yes" });
    expect(req.url).toBe("/project/apps/demo/?x=1&y=2");
  });

  it("leaves unrelated request URLs unchanged", () => {
    const req = { headers: {}, url: "/project/apps/demo/?x=1" };

    stripLegacyPublicAppRequestMetadata(req);

    expect(req.url).toBe("/project/apps/demo/?x=1");
  });
});
