/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

function loadBrowser(lite: boolean) {
  jest.resetModules();

  jest.doMock("@cocalc/frontend/lite", () => ({ lite }));
  jest.doMock("@cocalc/frontend/collaborators/invite-count", () => ({
    getUnreadIncomingInviteCount: () => 0,
  }));
  jest.doMock("./app-framework", () => ({
    redux: {
      getStore: (name: string) => ({
        get: (field: string) => {
          if (name === "customize" && field === "site_name") {
            return "CoCalc Launchpad";
          }
          if (name === "customize" && field === "ssh_remote_target") {
            return "";
          }
          return undefined;
        },
        getUnreadSize: () => 0,
      }),
    },
  }));

  return require("./browser") as typeof import("./browser");
}

describe("set_window_title", () => {
  beforeEach(() => {
    document.title = "";
  });

  afterEach(() => {
    jest.dontMock("@cocalc/frontend/lite");
    jest.dontMock("@cocalc/frontend/collaborators/invite-count");
    jest.dontMock("./app-framework");
  });

  it("uses CoCalc Plus exactly in lite mode", () => {
    const { set_window_title } = loadBrowser(true);

    set_window_title("Project Title");

    expect(document.title).toBe("CoCalc Plus");
  });

  it("keeps the site-name suffix outside lite mode", () => {
    const { set_window_title } = loadBrowser(false);

    set_window_title("Project Title");

    expect(document.title).toBe("Project Title - CoCalc Launchpad");
  });
});
