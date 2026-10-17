/*
The cookie origin policy composed with the real bay-public-origin: only the
database settings and the cluster's bay list are stubbed. The site must
always approve its own pages, whatever form the dns setting takes (with a
port, with http, or as a bare hostname), and the hub must agree with the
project hosts' list (getPublicSiteUrl keeps the scheme and port).
*/

let dns: string | undefined;
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ dns }),
}));
jest.mock("@cocalc/server/bay-public-origin", () => ({
  ...jest.requireActual("@cocalc/server/bay-public-origin"),
  getClusterBayPublicOrigins: async () => ({}),
}));

import { getSiteBrowserOrigins } from "@cocalc/server/bay-public-origin";
import {
  assertCookieOrigin,
  resetApprovedOriginsForTests,
} from "./browser-origin";

describe("cookie origin policy with the real site configuration", () => {
  const saved = {
    mode: process.env.COCALC_CONAT_ORIGIN_POLICY,
    extra: process.env.COCALC_CONAT_ALLOWED_ORIGINS,
  };
  beforeEach(() => {
    resetApprovedOriginsForTests();
    process.env.COCALC_CONAT_ORIGIN_POLICY = "enforce";
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

  it.each([
    ["cocalc.example.org", "https://cocalc.example.org"],
    ["https://cocalc.example.org/", "https://cocalc.example.org"],
    ["cocalc.example.org:8443", "https://cocalc.example.org:8443"],
    ["https://cocalc.example.org:8443", "https://cocalc.example.org:8443"],
    ["http://cocalc.internal:8080", "http://cocalc.internal:8080"],
    ["http://cocalc.internal", "http://cocalc.internal"],
    ["localhost:9100", "https://localhost:9100"],
    ["localhost:9100", "http://localhost:9100"],
    // the hostname form: the site behind a TLS proxy on 443
    ["cocalc.example.org:8443", "https://cocalc.example.org"],
    ["http://cocalc.example.org:8080", "https://cocalc.example.org"],
    ["http://localhost:9100", "http://localhost:9100"],
  ])("dns=%s approves its own page %s", async (setting, page) => {
    dns = setting;
    expect(await getSiteBrowserOrigins()).toContain(page);
    await expect(
      assertCookieOrigin({ origin: page }, "remember-me"),
    ).resolves.toBeUndefined();
    await expect(
      assertCookieOrigin({ origin: "https://evil.example" }, "remember-me"),
    ).rejects.toThrow("cross-site connection refused");
  });

  it("an unknown site origin is not configured: nothing is refused", async () => {
    dns = undefined;
    // An explicit dev origin alone must not make the site refuse itself.
    process.env.COCALC_CONAT_ALLOWED_ORIGINS = "http://localhost:5173";
    for (const origin of [
      "https://cocalc.example.org",
      "https://evil.example",
    ]) {
      await expect(
        assertCookieOrigin({ origin }, "remember-me"),
      ).resolves.toBeUndefined();
    }
  });
});
