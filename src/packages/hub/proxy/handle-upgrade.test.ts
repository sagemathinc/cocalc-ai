/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockVersionCheckFails = jest.fn();
const mockStripRememberMeCookie = jest.fn();
const mockParseReq = jest.fn();
const mockHasAccess = jest.fn();
const mockResolveAuthenticatedAccountId = jest.fn();
const mockSetProjectHostProxyAccountId = jest.fn();
const mockProxyConatWebsocket = jest.fn();

jest.mock("@cocalc/hub/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
    silly: jest.fn(),
  }),
}));

jest.mock("@cocalc/backend/base-path", () => ({
  __esModule: true,
  default: "",
}));

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
  setProjectHostProxyAccountId: (...args) =>
    mockSetProjectHostProxyAccountId(...args),
}));

jest.mock("./proxy-conat", () => ({
  proxyConatWebsocket: (...args) => mockProxyConatWebsocket(...args),
}));

describe("hub proxy websocket upgrades", () => {
  const project_id = "457f20dd-59d1-45c4-b5b1-a245d0e0a629";

  beforeEach(() => {
    jest.resetModules();
    mockVersionCheckFails.mockReset().mockReturnValue(false);
    mockStripRememberMeCookie.mockReset().mockReturnValue({
      cookie: "session=ok",
      remember_me: "remember",
      api_key: undefined,
    });
    mockParseReq.mockReset().mockReturnValue({
      type: "conat",
      project_id,
      route: { access: "write" },
    });
    mockHasAccess.mockReset().mockResolvedValue(true);
    mockResolveAuthenticatedAccountId
      .mockReset()
      .mockResolvedValue("account-1");
    mockSetProjectHostProxyAccountId.mockReset();
    mockProxyConatWebsocket.mockReset();
  });

  it("preserves authenticated account identity for project conat websocket upgrades", async () => {
    const initUpgrade = (await import("./handle-upgrade")).default;
    const proxyHandlers = { handleUpgrade: jest.fn() };
    const handler = initUpgrade(
      {
        proxyConat: false,
        localConatServer: undefined,
        isPersonal: false,
        projectProxyHandlersPromise: Promise.resolve(proxyHandlers),
      },
      "^/",
    );

    const req: any = {
      url: `/${project_id}/conat/?EIO=4&transport=websocket`,
      headers: {
        cookie: "remember_me=secret",
      },
    };
    const socket: any = {
      on: jest.fn(),
      write: jest.fn(),
      destroy: jest.fn(),
    };
    const head = Buffer.alloc(0);

    await handler(req, socket, head);

    expect(mockResolveAuthenticatedAccountId).toHaveBeenCalledWith({
      remember_me: "remember",
      api_key: undefined,
    });
    expect(mockSetProjectHostProxyAccountId).toHaveBeenCalledWith(
      req,
      "account-1",
    );
    expect(mockProxyConatWebsocket).not.toHaveBeenCalled();
    expect(proxyHandlers.handleUpgrade).toHaveBeenCalledWith(req, socket, head);
  });

  it("routes root Conat websocket upgrades to the Conat proxy", async () => {
    const initUpgrade = (await import("./handle-upgrade")).default;
    const proxyHandlers = { handleUpgrade: jest.fn() };
    const handler = initUpgrade(
      {
        proxyConat: true,
        localConatServer: true,
        isPersonal: false,
        projectProxyHandlersPromise: Promise.resolve(proxyHandlers),
      },
      "^/",
    );
    const req: any = {
      url: "/conat/?EIO=4&transport=websocket",
      headers: {},
    };
    const socket: any = {
      on: jest.fn(),
      write: jest.fn(),
      destroy: jest.fn(),
    };
    const head = Buffer.alloc(0);

    await handler(req, socket, head);

    expect(mockProxyConatWebsocket).toHaveBeenCalledWith(req, socket, head, {
      localConatServer: true,
    });
    expect(proxyHandlers.handleUpgrade).not.toHaveBeenCalled();
  });

  it("does not revive anonymous websocket access from a retired public hostname", async () => {
    mockStripRememberMeCookie.mockReturnValue({
      cookie: "",
      remember_me: undefined,
      api_key: undefined,
    });
    mockResolveAuthenticatedAccountId.mockResolvedValue(undefined);
    mockHasAccess.mockResolvedValue(false);
    const initUpgrade = (await import("./handle-upgrade")).default;
    const proxyHandlers = { handleUpgrade: jest.fn() };
    const handler = initUpgrade(
      {
        proxyConat: false,
        localConatServer: undefined,
        isPersonal: false,
        projectProxyHandlersPromise: Promise.resolve(proxyHandlers),
      },
      "^/",
    );
    const req: any = {
      url: `/${project_id}/apps/demo/socket`,
      headers: {
        cookie: "",
        "x-cocalc-public-app-host": "demo.example.invalid",
      },
    };
    const socket: any = {
      on: jest.fn(),
      write: jest.fn(),
      destroy: jest.fn(),
    };

    await handler(req, socket, Buffer.alloc(0));

    expect(mockHasAccess).toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith(
      "HTTP/1.1 401 Unauthorized\r\n\r\n",
    );
    expect(socket.destroy).toHaveBeenCalled();
    expect(proxyHandlers.handleUpgrade).not.toHaveBeenCalled();
  });
});
