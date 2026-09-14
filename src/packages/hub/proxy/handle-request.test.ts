/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockVersionCheckFails = jest.fn();
const mockStripRememberMeCookie = jest.fn();
const mockParseReq = jest.fn();
const mockHasAccess = jest.fn();
const mockResolveAuthenticatedAccountId = jest.fn();
const mockGetProjectHostRedirectUrl = jest.fn();
const mockSetProjectHostProxyAccountId = jest.fn();
const mockHandleFileDownload = jest.fn();
const mockConat = jest.fn();
const mockIsWorkspaceProjectRuntime = jest.fn();
const mockEnsureWorkspaceFileDownloadReadServer = jest.fn();

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

jest.mock("./project-host", () => ({
  getProjectHostRedirectUrl: (...args) =>
    mockGetProjectHostRedirectUrl(...args),
  setProjectHostProxyAccountId: (...args) =>
    mockSetProjectHostProxyAccountId(...args),
}));

jest.mock("@cocalc/conat/files/file-download", () => ({
  handleFileDownload: (...args) => mockHandleFileDownload(...args),
}));

jest.mock("@cocalc/backend/conat", () => ({
  conat: (...args) => mockConat(...args),
}));

jest.mock("@cocalc/server/launchpad/project-runtime", () => ({
  isWorkspaceProjectRuntime: (...args) =>
    mockIsWorkspaceProjectRuntime(...args),
}));

jest.mock("@cocalc/server/conat/project/workspace-filesystem", () => ({
  ensureWorkspaceFileDownloadReadServer: (...args) =>
    mockEnsureWorkspaceFileDownloadReadServer(...args),
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
    mockGetProjectHostRedirectUrl.mockReset();
    mockSetProjectHostProxyAccountId.mockReset();
    mockHandleFileDownload.mockReset().mockResolvedValue(undefined);
    mockConat.mockReset().mockReturnValue({ id: "workspace-client" });
    mockIsWorkspaceProjectRuntime.mockReset().mockReturnValue(false);
    mockEnsureWorkspaceFileDownloadReadServer.mockReset().mockResolvedValue({
      readServiceName: ":workspace",
      statSubject: "fs.project-457f20dd-59d1-45c4-b5b1-a245d0e0a629",
    });
  });

  it.each(["GET", "HEAD"])(
    "streams authenticated workspace file %s requests through Conat",
    async (method) => {
      mockIsWorkspaceProjectRuntime.mockReturnValue(true);
      const workspaceClient = { id: "workspace-client" };
      mockConat.mockReturnValue(workspaceClient);

      const init = (await import("./handle-request")).default;
      const proxyHandlers = { handleRequest: jest.fn() };
      const handler = init({
        isPersonal: false,
        projectProxyHandlersPromise: Promise.resolve(proxyHandlers),
      });

      const req: any = {
        url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/latex/tex.pdf?param=1",
        method,
        headers: { cookie: "remember_me=secret" },
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
      // The hub-side reader is always available, so downloads do not depend on
      // the project's own files:read service being up.
      expect(mockEnsureWorkspaceFileDownloadReadServer).toHaveBeenCalledWith({
        client: workspaceClient,
        project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
      });
      expect(mockHandleFileDownload).toHaveBeenCalledWith({
        req,
        res,
        url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/latex/tex.pdf?param=1",
        client: workspaceClient,
        readServiceName: ":workspace",
        statSubject: "fs.project-457f20dd-59d1-45c4-b5b1-a245d0e0a629",
        account_id: "account-1",
      });
      expect(mockGetProjectHostRedirectUrl).not.toHaveBeenCalled();
      expect(proxyHandlers.handleRequest).not.toHaveBeenCalled();
    },
  );

  it("checks workspace file access before opening the Conat stream", async () => {
    mockIsWorkspaceProjectRuntime.mockReturnValue(true);
    mockHasAccess.mockResolvedValue(false);

    const init = (await import("./handle-request")).default;
    const proxyHandlers = { handleRequest: jest.fn() };
    const handler = init({
      isPersonal: false,
      projectProxyHandlersPromise: Promise.resolve(proxyHandlers),
    });
    const req: any = {
      url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/files/home/user/private.pdf",
      method: "GET",
      headers: { cookie: "remember_me=secret" },
    };
    const res: any = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };

    await handler(req, res);

    expect(mockHasAccess).toHaveBeenCalled();
    expect(mockEnsureWorkspaceFileDownloadReadServer).not.toHaveBeenCalled();
    expect(mockHandleFileDownload).not.toHaveBeenCalled();
    expect(mockGetProjectHostRedirectUrl).not.toHaveBeenCalled();
    expect(proxyHandlers.handleRequest).not.toHaveBeenCalled();
  });

  it("applies workspace account fairness across projects using verified HTTP identity", async () => {
    const { EventEmitter, once } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const { init: initServer } = await import("@cocalc/conat/core/server");
    const { createServer, close } = await import("@cocalc/conat/files/read");
    const { handleFileDownload } = jest.requireActual(
      "@cocalc/conat/files/file-download",
    );
    const server = initServer({
      port: 0,
      autoscanInterval: 0,
      getUser: async (socket) => socket.handshake.auth,
    });
    if (server.state !== "ready") await once(server, "ready");
    const client = server.client({
      noCache: true,
      auth: { hub_id: "test-hub" },
    });
    const projects = Array.from(
      { length: 9 },
      (_, i) => `00000000-6000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const streams: InstanceType<typeof PassThrough>[] = [];
    const responses: any[] = [];
    const pending: Promise<void>[] = [];
    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 500; i++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Error("condition timed out");
    };
    try {
      mockIsWorkspaceProjectRuntime.mockReturnValue(true);
      mockConat.mockReturnValue(client);
      mockParseReq.mockImplementation((url: string) => ({
        type: "files",
        project_id: url.split("/")[1],
        route: { access: "read" },
      }));
      mockHandleFileDownload.mockImplementation(handleFileDownload);
      for (const project_id of projects)
        await createServer({
          client,
          project_id,
          name: ":workspace",
          createReadStream: () => {
            const stream = new PassThrough();
            streams.push(stream);
            return stream;
          },
        });
      mockEnsureWorkspaceFileDownloadReadServer.mockImplementation(
        async ({ project_id }) => ({
          readServiceName: ":workspace",
          statSubject: `fs.project-${project_id}`,
        }),
      );
      const init = (await import("./handle-request")).default;
      const handler = init({ isPersonal: false });
      const request = (project_id: string) => {
        const req: any = Object.assign(new EventEmitter(), {
          method: "GET",
          url: `/${project_id}/files/waiting.txt?account_id=untrusted`,
          headers: {
            cookie: "session=ok",
            "CN-File-Read-Principal": "account:untrusted",
          },
        });
        const res: any = Object.assign(new EventEmitter(), {
          setHeader: jest.fn(),
          write: jest.fn(() => true),
          writeHead: jest.fn(),
          end: jest.fn(),
          destroy: jest.fn(),
        });
        responses.push(res);
        pending.push(handler(req, res));
        return res;
      };
      for (let i = 0; i < 8; i++) {
        request(projects[i]);
        await until(() => streams.length === i + 1);
      }
      const denied = request(projects[8]);
      await until(() => denied.end.mock.calls.length > 0);
      expect(denied.statusCode).toBe(500);
      expect(streams).toHaveLength(8);
      expect(
        mockHandleFileDownload.mock.calls.every(
          ([opts]) => opts.account_id === "account-1",
        ),
      ).toBe(true);
      mockResolveAuthenticatedAccountId.mockResolvedValue("account-2");
      request(projects[8]);
      await until(() => streams.length === 9);
    } finally {
      for (const res of responses) {
        res.destroyed = true;
        res.emit("close");
      }
      await Promise.all(pending);
      await until(() => streams.every((stream) => stream.destroyed));
      for (const project_id of projects)
        await close({ project_id, name: ":workspace" });
      client.close();
      await server.close();
    }
  }, 20000);

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
    expect(mockSetProjectHostProxyAccountId).toHaveBeenCalledWith(
      req,
      "account-1",
    );
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

    expect(mockSetProjectHostProxyAccountId).toHaveBeenCalledWith(
      req,
      "account-1",
    );
    expect(proxyHandlers.handleRequest).toHaveBeenCalledWith(req, res);
  });

  it("preserves authenticated account identity for project conat proxy requests", async () => {
    mockParseReq.mockReturnValue({
      type: "conat",
      project_id: "457f20dd-59d1-45c4-b5b1-a245d0e0a629",
      route: { access: "write" },
    });

    const init = (await import("./handle-request")).default;
    const proxyHandlers = { handleRequest: jest.fn() };
    const handler = init({
      isPersonal: false,
      projectProxyHandlersPromise: Promise.resolve(proxyHandlers),
    });

    const req: any = {
      url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/conat/?EIO=4&transport=polling",
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

    expect(mockResolveAuthenticatedAccountId).toHaveBeenCalledWith({
      remember_me: "remember",
      api_key: undefined,
    });
    expect(mockSetProjectHostProxyAccountId).toHaveBeenCalledWith(
      req,
      "account-1",
    );
    expect(mockGetProjectHostRedirectUrl).not.toHaveBeenCalled();
    expect(proxyHandlers.handleRequest).toHaveBeenCalledWith(req, res);
  });

  it("does not revive anonymous app access from retired public-app inputs", async () => {
    mockStripRememberMeCookie.mockReturnValue({
      cookie: "",
      remember_me: undefined,
      api_key: undefined,
    });
    const init = (await import("./handle-request")).default;
    const proxyHandlers = { handleRequest: jest.fn() };
    const handler = init({
      isPersonal: false,
      projectProxyHandlersPromise: Promise.resolve(proxyHandlers),
    });
    const req: any = {
      url: "/457f20dd-59d1-45c4-b5b1-a245d0e0a629/apps/demo/?cocalc_app_token=retired",
      method: "GET",
      headers: {
        cookie: "",
        "x-cocalc-public-app-host": "demo.example.invalid",
      },
    };
    const res: any = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };

    await handler(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(
      500,
      expect.objectContaining({ "X-Content-Type-Options": "nosniff" }),
    );
    expect(mockHasAccess).not.toHaveBeenCalled();
    expect(proxyHandlers.handleRequest).not.toHaveBeenCalled();
    expect(req.url).toBe("/457f20dd-59d1-45c4-b5b1-a245d0e0a629/apps/demo/");
    expect(req.headers).not.toHaveProperty("x-cocalc-public-app-host");
  });
});
