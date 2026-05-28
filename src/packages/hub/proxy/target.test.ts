/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockHasAccess = jest.fn();
const mockResolveAuthenticatedAccountId = jest.fn();
const mockStartProject = jest.fn();
const mockTouchProject = jest.fn();

jest.mock("@cocalc/hub/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("@cocalc/hub/servers/database", () => ({
  getDatabase: () => ({
    touch_project: mockTouchProject,
  }),
}));

jest.mock("@cocalc/server/conat/api/projects", () => ({
  start: (...args: any[]) => mockStartProject(...args),
}));

jest.mock("./check-for-access-to-project", () => ({
  __esModule: true,
  default: (...args: any[]) => mockHasAccess(...args),
  resolveAuthenticatedAccountId: (...args: any[]) =>
    mockResolveAuthenticatedAccountId(...args),
}));

jest.mock(
  "../projects",
  () => ({
    new_project: jest.fn(() => ({
      named_server_port: jest.fn(async () => 1234),
    })),
  }),
  { virtual: true },
);

describe("proxy target access", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    mockHasAccess.mockReset();
    mockResolveAuthenticatedAccountId.mockReset();
    mockStartProject.mockReset();
    mockTouchProject.mockReset();
  });

  it("classifies proxy, app-server, and conat proxy routes as write access", async () => {
    const { getProxyRouteDefinition } = await import("./routes");

    for (const route of ["port", "proxy", "server", "apps", "conat"]) {
      expect(getProxyRouteDefinition(route)?.access).toBe("write");
    }
  });

  it("requires write access before proxy/app-server autostart", async () => {
    mockHasAccess.mockResolvedValue(false);
    const projectControl = jest.fn(() => ({
      state: jest.fn(async () => ({
        state: "stopped",
        ip: "10.0.0.5",
      })),
    }));
    const { getTarget } = await import("./target");

    await expect(
      getTarget({
        remember_me: "remember",
        url: `/${project_id}/port/12345/`,
        isPersonal: false,
        projectControl,
        parsed: {
          key: "proxy-test",
          type: "proxy",
          project_id,
          port_desc: "12345",
          internal_url: undefined,
        } as any,
      }),
    ).rejects.toThrow("user does not have write access to project");

    expect(mockHasAccess).toHaveBeenCalledWith({
      project_id,
      remember_me: "remember",
      api_key: undefined,
      type: "write",
      isPersonal: false,
    });
    expect(mockStartProject).not.toHaveBeenCalled();
  });

  it("autostarts proxied services only after collaborator-level proxy access", async () => {
    mockHasAccess.mockResolvedValue(true);
    mockResolveAuthenticatedAccountId.mockResolvedValue(
      "22222222-2222-4222-8222-222222222222",
    );
    mockStartProject.mockResolvedValue(undefined);
    const stateMock = jest
      .fn()
      .mockResolvedValueOnce({
        state: "stopped",
        ip: "10.0.0.5",
      })
      .mockResolvedValueOnce({
        state: "running",
        ip: "10.0.0.5",
      });
    const projectControl = jest.fn(() => ({
      state: stateMock,
    }));
    const { getTarget } = await import("./target");

    await expect(
      getTarget({
        remember_me: "remember",
        url: `/${project_id}/proxy/12345/`,
        isPersonal: false,
        projectControl,
        parsed: {
          key: "port-start-test",
          type: "port",
          project_id,
          port_desc: "12345",
          internal_url: undefined,
        } as any,
      }),
    ).resolves.toEqual({
      host: "10.0.0.5",
      port: 12345,
      internal_url: undefined,
    });

    expect(mockStartProject).toHaveBeenCalledWith({
      account_id: "22222222-2222-4222-8222-222222222222",
      project_id,
      autostart: true,
    });
  });
});
