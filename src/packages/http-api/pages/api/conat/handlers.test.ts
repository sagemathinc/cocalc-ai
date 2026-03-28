/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import hubBridge from "@cocalc/server/api/hub-bridge";
import projectBridge from "@cocalc/server/api/project-bridge";
import isCollaborator from "@cocalc/server/projects/is-collaborator";

import hubHandler from "./hub";
import projectHandler from "./project";

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: jest.fn(),
}));

jest.mock("@cocalc/server/api/hub-bridge", () => jest.fn());
jest.mock("@cocalc/server/api/project-bridge", () => jest.fn());
jest.mock("@cocalc/server/projects/is-collaborator", () => jest.fn());

const mockGetAccountFromApiKey = jest.mocked(getAccountFromApiKey);
const mockHubBridge = jest.mocked(hubBridge);
const mockProjectBridge = jest.mocked(projectBridge);
const mockIsCollaborator = jest.mocked(isCollaborator);

describe("/api/conat/hub", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test("requires an account api key", async () => {
    mockGetAccountFromApiKey.mockResolvedValue(undefined as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.ping" },
      method: "POST",
      url: "/api/conat/hub",
    });

    await hubHandler(req, res);
    expect(res._getJSONData()).toEqual({
      error:
        "must be signed in and MUST provide an api key (cookies are not allowed)",
    });
  });

  test("bridges hub rpc calls for an authenticated account", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({ account_id: "acc-1" } as any);
    mockHubBridge.mockResolvedValue({ ok: true } as any);

    const { req, res } = createMocks({
      body: { args: [["acc-2"]], name: "system.getNames", timeout: 5000 },
      method: "POST",
      url: "/api/conat/hub",
    });

    await hubHandler(req, res);
    expect(mockHubBridge).toHaveBeenCalledWith({
      account_id: "acc-1",
      args: [["acc-2"]],
      name: "system.getNames",
      timeout: 5000,
    });
    expect(res._getJSONData()).toEqual({ ok: true });
  });
});

describe("/api/conat/project", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test("requires either an account or project api key", async () => {
    mockGetAccountFromApiKey.mockResolvedValue(undefined as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.ping", project_id: "proj-1" },
      method: "POST",
      url: "/api/conat/project",
    });

    await projectHandler(req, res);
    expect(res._getJSONData()).toEqual({
      error: "must sign in as project or account",
    });
  });

  test("requires account callers to be collaborators", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({ account_id: "acc-1" } as any);
    mockIsCollaborator.mockResolvedValue(false as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.ping", project_id: "proj-1" },
      method: "POST",
      url: "/api/conat/project",
    });

    await projectHandler(req, res);
    expect(mockIsCollaborator).toHaveBeenCalledWith({
      account_id: "acc-1",
      project_id: "proj-1",
    });
    expect(res._getJSONData()).toEqual({
      error: "user must be a collaborator on the project",
    });
  });

  test("accepts project-specific api keys without collaborator checks", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({ project_id: "proj-1" } as any);
    mockProjectBridge.mockResolvedValue({ pong: true } as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.ping", project_id: "proj-1" },
      method: "POST",
      url: "/api/conat/project",
    });

    await projectHandler(req, res);
    expect(mockIsCollaborator).not.toHaveBeenCalled();
    expect(mockProjectBridge).toHaveBeenCalledWith({
      args: [],
      name: "system.ping",
      project_id: "proj-1",
      timeout: undefined,
    });
    expect(res._getJSONData()).toEqual({ pong: true });
  });
});
