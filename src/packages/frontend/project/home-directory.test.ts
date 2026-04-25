/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getProjectStore = jest.fn();
const configuration = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectStore: (...args) => getProjectStore(...args),
  },
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: true,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_client: {
      configuration: (...args) => configuration(...args),
    },
  },
}));

jest.mock(
  "@cocalc/util/project-runtime",
  () => ({
    DEFAULT_PROJECT_RUNTIME_HOME: "/home/user",
    DEFAULT_PROJECT_RUNTIME_USER: "user",
  }),
  { virtual: true },
);

describe("getProjectHomeDirectory", () => {
  beforeEach(() => {
    jest.resetModules();
    getProjectStore.mockReset();
    configuration.mockReset();
  });

  it("infers lite home from open file tabs before capabilities load", () => {
    getProjectStore.mockReturnValue({
      get: (key: string) => {
        if (key === "open_files_order") {
          return {
            toArray: () => ["/home/wstein/scratch/demo.chat"],
          };
        }
        return undefined;
      },
      getIn: () => undefined,
    });

    const { getProjectHomeDirectory } = require("./home-directory");
    expect(getProjectHomeDirectory("project-1")).toBe("/home/wstein");
  });

  it("does not infer legacy /root paths as the project home", () => {
    getProjectStore
      .mockReturnValueOnce({
        get: (key: string) => {
          if (key === "open_files_order") {
            return {
              toArray: () => ["/root/demo.txt"],
            };
          }
          return undefined;
        },
        getIn: () => undefined,
      })
      .mockReturnValueOnce({
        get: () => undefined,
        getIn: () => undefined,
      });

    const { getProjectHomeDirectory } = require("./home-directory");
    expect(getProjectHomeDirectory("project-1")).toBe("/home/user");
    expect(getProjectHomeDirectory("project-2")).toBe("/home/user");
  });

  it("reads runtime home and user from capabilities", () => {
    getProjectStore.mockReturnValue({
      get: (key: string) => {
        if (key === "available_features") {
          return {
            get: (feature: string) => {
              if (feature === "homeDirectory") return "/home/user";
              if (feature === "runtimeUser") return "user";
            },
          };
        }
        return undefined;
      },
      getIn: () => undefined,
    });

    const {
      getProjectHomeDirectory,
      getProjectRuntimeUser,
    } = require("./home-directory");
    expect(getProjectHomeDirectory("project-1")).toBe("/home/user");
    expect(getProjectRuntimeUser("project-1")).toBe("user");
  });

  it("falls back cleanly when project store access is unavailable", () => {
    getProjectStore.mockImplementation(() => {
      throw new Error("synthetic test project id");
    });

    const {
      getProjectHomeDirectory,
      getProjectRuntimeUser,
    } = require("./home-directory");
    expect(getProjectHomeDirectory("project-1")).toBe("/home/user");
    expect(getProjectRuntimeUser("project-1")).toBe("user");
  });

  it("resolves lite home from project configuration when store heuristics are stale", async () => {
    getProjectStore.mockReturnValue({
      get: (key: string) => {
        if (key === "open_files_order") {
          return {
            toArray: () => ["/home/wstein/public-viewer/index.json"],
          };
        }
        return undefined;
      },
      getIn: () => undefined,
    });
    configuration.mockResolvedValue({
      capabilities: {
        homeDirectory: "/home/wstein/scratch/cocalc-lite-daemon1",
      },
    });

    const {
      getProjectHomeDirectory,
      resolveProjectHomeDirectory,
    } = require("./home-directory");
    expect(getProjectHomeDirectory("project-1")).toBe("/home/wstein");
    await expect(resolveProjectHomeDirectory("project-1")).resolves.toBe(
      "/home/wstein/scratch/cocalc-lite-daemon1",
    );
    expect(getProjectHomeDirectory("project-1")).toBe(
      "/home/wstein/scratch/cocalc-lite-daemon1",
    );
  });
});
