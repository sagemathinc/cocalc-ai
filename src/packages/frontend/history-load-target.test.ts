/** @jest-environment jsdom */

const pageActions = {
  set_active_tab: jest.fn(),
  setState: jest.fn(),
};
const accountActions = {
  setState: jest.fn(),
  set_active_tab: jest.fn(),
  push_state: jest.fn(),
  setFragment: jest.fn(),
};
const projectsActions = {
  load_target: jest.fn(),
};
const mentionsActions = {
  set_filter: jest.fn(),
};

const accountStore = {
  get: jest.fn((key: string) => {
    if (key === "is_logged_in") {
      return true;
    }
    return undefined;
  }),
};

const mockRedux = {
  getStore: jest.fn((name: string) => {
    if (name === "account") {
      return accountStore;
    }
    return {};
  }),
  getActions: jest.fn((name: string) => {
    switch (name) {
      case "page":
        return pageActions;
      case "account":
        return accountActions;
      case "projects":
        return projectsActions;
      case "mentions":
        return mentionsActions;
      default:
        throw Error(`unexpected actions store ${name}`);
    }
  }),
};

const fragment = {
  get: jest.fn(() => ({ line: "7" })),
  decode: jest.fn((hash: string) => ({ hash })),
};

const getNotificationFilterFromFragment = jest.fn((hash: string) => ({
  filter: "mentions",
  id: hash === "thread" ? "notif-1" : "notif-default",
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: mockRedux,
}));

jest.mock("@cocalc/frontend/misc/fragment-id", () => ({
  __esModule: true,
  default: fragment,
}));

jest.mock("./notifications/fragment", () => ({
  getNotificationFilterFromFragment: (hash: string) =>
    getNotificationFilterFromFragment(hash),
}));

import { load_target } from "./history";

describe("load_target", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("routes settings targets through account route state", () => {
    load_target("settings/vouchers", false, false);

    expect(pageActions.set_active_tab).toHaveBeenCalledWith("account", false);
    expect(accountActions.setState).toHaveBeenCalledWith({
      active_page: "vouchers",
      active_sub_tab: undefined,
    });
  });

  it("routes project targets through projects actions", () => {
    load_target("projects/project-1/files/work.txt", true, false);

    expect(projectsActions.load_target).toHaveBeenCalledWith(
      "project-1/files/work.txt",
      true,
      true,
      false,
      { line: "7" },
    );
  });

  it("handles ssh and notifications through the shared page route model", () => {
    load_target("ssh", false, false);
    expect(pageActions.set_active_tab).toHaveBeenCalledWith("ssh", false);

    load_target("notifications#thread", false, false);
    expect(getNotificationFilterFromFragment).toHaveBeenCalledWith("thread");
    expect(mentionsActions.set_filter).toHaveBeenCalledWith(
      "mentions",
      "notif-1",
    );
    expect(pageActions.set_active_tab).toHaveBeenCalledWith(
      "notifications",
      false,
    );
  });
});
