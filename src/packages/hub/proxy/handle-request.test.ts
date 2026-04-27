/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockVersionCheckFails = jest.fn();
const mockStripRememberMeCookie = jest.fn();
const mockParseReq = jest.fn();
const mockHasAccess = jest.fn();
const mockResolveAuthenticatedAccountId = jest.fn();
const mockIsPublicAppSubdomainRequest = jest.fn();
const mockGetProjectHostRedirectUrl = jest.fn();

jest.mock("./version", () => ({
  versionCheckFails: (...args) => mockVersionCheckFails(...args),
}));

jest.mock("./strip-remember-me-cookie", () => ({
  __esModule: true,
  default: (...args) => mockStripRememberMeCookie(...args),
}));

jest.mock("./parse", () => ({
  parseReq: (...args) => mockParseReq(...args),
}));

jest.mock("./check-for-access-to-project", () => ({
  __esModule: true,
  default: (...args) => mockHasAccess(...args),
  resolveAuthenticatedAccountId: (...args) =>
    mockResolveAuthenticatedAccountId(...args),
}));

jest.mock("./public-app-subdomain", () => ({
  isPublicAppSubdomainRequest: (...args) =>
    mockIsPublicAppSubdomainRequest(...args),
}));

jest.mock("./project-host", () => ({
  getProjectHostRedirectUrl: (...args) =>
    mockGetProjectHostRedirectUrl(...args),
}));

describe("hub proxy file downloads", () => {
  beforeEach(() => {
    jest.resetModules();
    mockVersionCheckFails.mockReset().mockReturnValue(false);
    mockStripRememberMeCookie.mockReset().mockReturnValue({
      cookie: "session=ok",
      remember_me: "remember",
      api_key: undefined,
    });
    mockParseReq.mockReset().mockReturnValue({
      type: "files",
      project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
      route: { access: "read" },
    });
    mockHasAccess.mockReset().mockResolvedValue(true);
    mockResolveAuthenticatedAccountId
      .mockReset()
      .mockResolvedValue("account-1");
    mockIsPublicAppSubdomainRequest.mockReset().mockReturnValue(false);
    mockGetProjectHostRedirectUrl.mockReset();
  });

  it("redirects authenticated file downloads to the project-host", async () => {
    mockGetProjectHostRedirectUrl.mockResolvedValue(
      "https://host.example/project/files/home/user/a.txt?token=1",
    );

    const init = (await import("./handle-request")).default;
    const proxyHandlers = { handleRequest: jest.fn() };
    const handler = init({
      isPersonal: false,
      projectProxyHandlersPromise: Promise.resolve(proxyHandlers),
    });

    const req: any = {
      url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt?download",
      method: "GET",
      headers: {
        cookie: "remember_me=secret",
      },
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      end: jest.fn(),
    };

    await handler(req, res);

    expect(mockHasAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
        type: "read",
      }),
    );
    expect(mockResolveAuthenticatedAccountId).toHaveBeenCalledWith({
      remember_me: "remember",
      api_key: undefined,
    });
    expect(mockGetProjectHostRedirectUrl).toHaveBeenCalledWith({
      project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
      path: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt?download",
      account_id: "account-1",
    });
    expect(res.statusCode).toBe(307);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Location",
      "https://host.example/project/files/home/user/a.txt?token=1",
    );
    expect(res.end).toHaveBeenCalled();
    expect(proxyHandlers.handleRequest).not.toHaveBeenCalled();
  });

  it("falls through to the generic proxy path when no redirect target is available", async () => {
    mockGetProjectHostRedirectUrl.mockResolvedValue(undefined);

    const init = (await import("./handle-request")).default;
    const proxyHandlers = { handleRequest: jest.fn() };
    const handler = init({
      isPersonal: false,
      projectProxyHandlersPromise: Promise.resolve(proxyHandlers),
    });

    const req: any = {
      url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt",
      method: "GET",
      headers: {
        cookie: "remember_me=secret",
      },
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      end: jest.fn(),
    };

    await handler(req, res);

    expect(proxyHandlers.handleRequest).toHaveBeenCalledWith(req, res);
  });
});
