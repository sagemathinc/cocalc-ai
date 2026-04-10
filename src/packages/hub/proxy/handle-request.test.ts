/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockVersionCheckFails = jest.fn();
const mockStripRememberMeCookie = jest.fn();
const mockParseReq = jest.fn();
const mockHasAccess = jest.fn();
const mockHandleFileDownload = jest.fn();
const mockConatWithProjectRouting = jest.fn();
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
  resolveAuthenticatedAccountId: jest.fn(),
}));

jest.mock("@cocalc/conat/files/file-download", () => ({
  handleFileDownload: (...args) => mockHandleFileDownload(...args),
}));

jest.mock("./public-app-subdomain", () => ({
  isPublicAppSubdomainRequest: (...args) =>
    mockIsPublicAppSubdomainRequest(...args),
}));

jest.mock("./project-host", () => ({
  getProjectHostRedirectUrl: (...args) =>
    mockGetProjectHostRedirectUrl(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  conatWithProjectRouting: (...args) => mockConatWithProjectRouting(...args),
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
    mockHandleFileDownload.mockReset().mockResolvedValue(undefined);
    mockIsPublicAppSubdomainRequest.mockReset().mockReturnValue(false);
    mockGetProjectHostRedirectUrl.mockReset();
    mockConatWithProjectRouting.mockReset();
  });

  it("passes the routed conat client to file downloads", async () => {
    const routedClient = { id: "routed-client" };
    mockConatWithProjectRouting.mockReturnValue(routedClient);

    const init = (await import("./handle-request")).default;
    const handler = init({ isPersonal: false });

    const req: any = {
      url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt",
      method: "GET",
      headers: {
        cookie: "remember_me=secret",
      },
    };
    const res: any = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };

    await handler(req, res);

    expect(mockConatWithProjectRouting).toHaveBeenCalledTimes(1);
    expect(mockHandleFileDownload).toHaveBeenCalledWith({
      req,
      res,
      url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt",
      client: routedClient,
    });
  });
});
