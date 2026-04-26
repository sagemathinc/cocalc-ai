/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockVersionCheckFails = jest.fn();
const mockStripRememberMeCookie = jest.fn();
const mockParseReq = jest.fn();
const mockHasAccess = jest.fn();
const mockResolveAuthenticatedAccountId = jest.fn();
const mockHandleFileDownload = jest.fn();
const mockConatWithProjectRouting = jest.fn();
const mockIsPublicAppSubdomainRequest = jest.fn();
const mockGetProjectHostRedirectUrl = jest.fn();
const mockCallHub = jest.fn();

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

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args) => mockCallHub(...args),
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
    mockHandleFileDownload.mockReset().mockResolvedValue(undefined);
    mockIsPublicAppSubdomainRequest.mockReset().mockReturnValue(false);
    mockGetProjectHostRedirectUrl.mockReset();
    mockConatWithProjectRouting.mockReset();
    mockCallHub.mockReset();
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
    expect(mockHandleFileDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        res,
        url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt",
        client: routedClient,
        beforeExplicitDownload: expect.any(Function),
        onExplicitDownloadComplete: expect.any(Function),
      }),
    );
  });

  it("uses a typed hub api for explicit download metering callbacks", async () => {
    const routedClient = { id: "routed-client" };
    mockConatWithProjectRouting.mockReturnValue(routedClient);
    mockCallHub.mockImplementation(async ({ name, args, client }) => {
      expect(client).toBe(routedClient);
      if (name === "system.getManagedProjectEgressPolicy") {
        expect(args).toEqual([
          {
            account_id: "account-1",
            project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
            category: "file-download",
          },
        ]);
        return { allowed: true };
      }
      if (name === "system.recordManagedProjectEgress") {
        expect(args).toEqual([
          {
            account_id: "account-1",
            project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
            category: "file-download",
            bytes: 123,
            metadata: {
              request_path:
                "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt?download",
              partial: false,
            },
          },
        ]);
        return { recorded: true, account_id: "account-1" };
      }
      throw new Error(`unexpected hub call: ${name}`);
    });

    const init = (await import("./handle-request")).default;
    const handler = init({ isPersonal: false });

    const req: any = {
      url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt?download",
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

    const call = mockHandleFileDownload.mock.calls[0]?.[0];
    expect(
      await call.beforeExplicitDownload({
        project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
        path: "/home/user/a.txt",
        request_path:
          "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt?download",
      }),
    ).toEqual({ allowed: true });
    await call.onExplicitDownloadComplete({
      project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
      path: "/home/user/a.txt",
      request_path:
        "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt?download",
      bytes: 123,
      partial: false,
    });
    expect(mockCallHub).toHaveBeenCalledTimes(2);
  });

  it("falls back to owner attribution when the downloader is unknown", async () => {
    const routedClient = { id: "routed-client" };
    mockConatWithProjectRouting.mockReturnValue(routedClient);
    mockResolveAuthenticatedAccountId.mockResolvedValue(undefined);
    mockCallHub.mockImplementation(async ({ name, args, client }) => {
      expect(client).toBe(routedClient);
      if (name === "system.getManagedProjectEgressPolicy") {
        expect(args).toEqual([
          {
            project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
            category: "file-download",
          },
        ]);
        return { allowed: true };
      }
      if (name === "system.recordManagedProjectEgress") {
        expect(args).toEqual([
          {
            project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
            category: "file-download",
            bytes: 123,
            metadata: {
              request_path:
                "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt?download",
              partial: false,
            },
          },
        ]);
        return { recorded: true, account_id: "owner-1" };
      }
      throw new Error(`unexpected hub call: ${name}`);
    });

    const init = (await import("./handle-request")).default;
    const handler = init({ isPersonal: false });

    const req: any = {
      url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt?download",
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

    const call = mockHandleFileDownload.mock.calls[0]?.[0];
    await call.beforeExplicitDownload({
      project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
      path: "/home/user/a.txt",
      request_path:
        "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt?download",
    });
    await call.onExplicitDownloadComplete({
      project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
      path: "/home/user/a.txt",
      request_path:
        "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/a.txt?download",
      bytes: 123,
      partial: false,
    });
    expect(mockCallHub).toHaveBeenCalledTimes(2);
  });
});
