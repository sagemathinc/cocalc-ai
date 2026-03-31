/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const getProjectStore = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectStore: (...args) => getProjectStore(...args),
  },
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: true,
}));

describe("getProjectHomeDirectory", () => {
  beforeEach(() => {
    jest.resetModules();
    getProjectStore.mockReset();
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

  it("reuses a resolved lite home as the default fallback for later projects", () => {
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
    expect(getProjectHomeDirectory("project-1")).toBe("/root");
    expect(getProjectHomeDirectory("project-2")).toBe("/root");
  });
});
