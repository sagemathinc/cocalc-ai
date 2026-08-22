/** @jest-environment jsdom */

import {
  getHostsPageHref,
  HOSTS_PAGE_TAB_EVENT,
  openHostsPage,
} from "./navigation";
import { redux } from "@cocalc/frontend/app-framework";
import { set_url_with_search } from "@cocalc/frontend/history";

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/base",
}));

jest.mock("@cocalc/frontend/history", () => ({
  set_url_with_search: jest.fn(),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: jest.fn(),
  },
}));

describe("hosts page navigation", () => {
  it("opens the account VMs tab through in-app history", () => {
    const setActiveTab = jest.fn();
    (redux.getActions as jest.Mock).mockReturnValue({
      set_active_tab: setActiveTab,
    });
    const onTab = jest.fn();
    window.addEventListener(HOSTS_PAGE_TAB_EVENT, onTab);

    openHostsPage("vms");

    expect(set_url_with_search).toHaveBeenCalledWith("/hosts", "?tab=vms");
    expect(setActiveTab).toHaveBeenCalledWith("hosts", false);
    expect(onTab).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "vms" }),
    );
    expect(getHostsPageHref("vms")).toBe("/base/hosts?tab=vms");

    window.removeEventListener(HOSTS_PAGE_TAB_EVENT, onTab);
  });
});
