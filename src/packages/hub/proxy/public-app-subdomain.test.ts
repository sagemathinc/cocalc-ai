/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetPublicAppRouteByHostname = jest.fn();
const mockIsLaunchpadProduct = jest.fn();

jest.mock("@cocalc/server/app-public-subdomains", () => ({
  getPublicAppRouteByHostname: (...args) =>
    mockGetPublicAppRouteByHostname(...args),
}));

jest.mock("@cocalc/server/launchpad/mode", () => ({
  isLaunchpadProduct: (...args) => mockIsLaunchpadProduct(...args),
}));

describe("public app subdomain rewrite", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetPublicAppRouteByHostname.mockReset().mockResolvedValue(undefined);
    mockIsLaunchpadProduct.mockReset().mockReturnValue(true);
  });

  it("skips lookup for obvious local hosts", async () => {
    const {
      maybeRewritePublicAppSubdomainRequest,
      shouldSkipPublicAppRouteLookup,
    } = await import("./public-app-subdomain");
    expect(shouldSkipPublicAppRouteLookup("127.0.0.1")).toBe(true);
    expect(shouldSkipPublicAppRouteLookup("localhost")).toBe(true);
    expect(shouldSkipPublicAppRouteLookup("::1")).toBe(true);

    const req: any = {
      headers: { host: "127.0.0.1:9100" },
      url: "/favicon.ico",
    };
    expect(await maybeRewritePublicAppSubdomainRequest(req)).toBe(false);
    expect(mockGetPublicAppRouteByHostname).not.toHaveBeenCalled();
  });

  it("looks up non-local hostnames", async () => {
    const { maybeRewritePublicAppSubdomainRequest } =
      await import("./public-app-subdomain");
    const req: any = {
      headers: { host: "lite4b.cocalc.ai" },
      url: "/favicon.ico",
    };
    expect(await maybeRewritePublicAppSubdomainRequest(req)).toBe(false);
    expect(mockGetPublicAppRouteByHostname).toHaveBeenCalledWith(
      "lite4b.cocalc.ai",
    );
  });
});
